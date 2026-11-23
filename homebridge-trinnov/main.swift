//
//  main.swift
//  homebridge-trinnov
//
//  A macOS Swift diagnostic utility to probe Trinnov Altitude processors,
//  query live automation status over TCP (port 44100), monitor real-time
//  ASCII events, and transmit Wake-on-LAN magic packets.
//

import Darwin
import Foundation

struct TrinnovDiagnosticCLI {
    static func run() {
        let args = Array(CommandLine.arguments.dropFirst())

        if args.contains("-h") || args.contains("--help") || args.isEmpty {
            printUsage()
            return
        }

        var host: String?
        var port: UInt16 = 44100
        var mac: String?
        var clientName = "HomebridgeCLI"
        var mode = "probe"

        var i = 0
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "--host", "-H":
                if i + 1 < args.count {
                    host = args[i + 1]
                    i += 1
                }
            case "--port", "-p":
                if i + 1 < args.count, let parsed = UInt16(args[i + 1]) {
                    port = parsed
                    i += 1
                }
            case "--mac", "-m":
                if i + 1 < args.count {
                    mac = args[i + 1]
                    i += 1
                }
            case "--client", "-c":
                if i + 1 < args.count {
                    clientName = args[i + 1]
                    i += 1
                }
            case "--probe":
                mode = "probe"
            case "--status", "-s":
                mode = "status"
            case "--monitor", "-M":
                mode = "monitor"
            case "--wake", "-w":
                mode = "wake"
            default:
                break
            }
            i += 1
        }

        switch mode {
        case "wake":
            guard let macAddress = mac, !macAddress.isEmpty else {
                print("Error: --wake requires --mac <AA:BB:CC:DD:EE:FF>")
                printUsage()
                return
            }
            sendWakeOnLan(mac: macAddress)

        case "probe":
            guard let targetHost = host, !targetHost.isEmpty else {
                print("Error: --probe requires --host <ip-or-hostname>")
                printUsage()
                return
            }
            probeProcessor(host: targetHost, port: port)

        case "status":
            guard let targetHost = host, !targetHost.isEmpty else {
                print("Error: --status requires --host <ip-or-hostname>")
                printUsage()
                return
            }
            runTcpSession(
                host: targetHost,
                port: port,
                clientName: clientName,
                commands: ["send_volume", "get_current_profile", "get_all_label", "bye"],
                keepAlive: false
            )

        case "monitor":
            guard let targetHost = host, !targetHost.isEmpty else {
                print("Error: --monitor requires --host <ip-or-hostname>")
                printUsage()
                return
            }
            print("Monitoring Trinnov Altitude at \(targetHost):\(port)... Press Ctrl+C to stop.")
            runTcpSession(
                host: targetHost,
                port: port,
                clientName: clientName,
                commands: ["send_volume", "get_current_profile", "get_all_label"],
                keepAlive: true
            )

        default:
            printUsage()
        }
    }

    static func probeProcessor(host: String, port: UInt16) {
        let pingOk = runPing(host: host)
        print("ICMP Ping (\(host)): \(pingOk ? "RESPONDING" : "NO RESPONSE")")
        runTcpSession(
            host: host,
            port: port,
            clientName: "HomebridgeProbe",
            commands: ["send_volume", "bye"],
            keepAlive: false
        )
    }

    static func runPing(host: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/sbin/ping")
        process.arguments = ["-c", "1", "-W", "1500", host]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    static func runTcpSession(
        host: String,
        port: UInt16,
        clientName: String,
        commands: [String],
        keepAlive: Bool
    ) {
        var hints = addrinfo(
            ai_flags: 0,
            ai_family: AF_UNSPEC,
            ai_socktype: SOCK_STREAM,
            ai_protocol: IPPROTO_TCP,
            ai_addrlen: 0,
            ai_canonname: nil,
            ai_addr: nil,
            ai_next: nil
        )
        var res: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(host, String(port), &hints, &res)
        guard status == 0, let addrList = res else {
            print("Failed to resolve \(host):\(port)")
            return
        }
        defer { freeaddrinfo(addrList) }

        let sock = socket(addrList.pointee.ai_family, addrList.pointee.ai_socktype, addrList.pointee.ai_protocol)
        guard sock >= 0 else {
            print("Failed to create TCP socket")
            return
        }
        defer { close(sock) }

        if connect(sock, addrList.pointee.ai_addr, addrList.pointee.ai_addrlen) != 0 {
            print("TCP connection to \(host):\(port) failed (unit may be in standby).")
            return
        }

        print("Connected to \(host):\(port)")
        let payload = (["id \(clientName)"] + commands).map { "\($0)\r\n" }.joined()
        _ = payload.withCString { ptr in
            send(sock, ptr, strlen(ptr), 0)
        }

        var tv = timeval(tv_sec: keepAlive ? 300 : 2, tv_usec: 0)
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var buffer = [CChar](repeating: 0, count: 4096)
        while true {
            let n = recv(sock, &buffer, buffer.count - 1, 0)
            if n <= 0 {
                break
            }
            buffer[n] = 0
            if let text = String(validatingUTF8: buffer) {
                print(text, terminator: "")
            }
        }
    }

    static func sendWakeOnLan(mac: String) {
        let hex = mac.unicodeScalars.filter {
            ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0)
        }
        let clean = String(String.UnicodeScalarView(hex))
        guard clean.count == 12 else {
            print("Invalid MAC address: \(mac)")
            return
        }

        var macBytes = [UInt8]()
        var index = clean.startIndex
        for _ in 0..<6 {
            let nextIndex = clean.index(index, offsetBy: 2)
            if let byte = UInt8(clean[index..<nextIndex], radix: 16) {
                macBytes.append(byte)
            }
            index = nextIndex
        }

        var packet = [UInt8](repeating: 0xFF, count: 6)
        for _ in 0..<16 {
            packet.append(contentsOf: macBytes)
        }

        let sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard sock >= 0 else {
            print("Unable to create UDP socket")
            return
        }
        defer { close(sock) }

        var broadcastEnable: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcastEnable, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(9).bigEndian
        addr.sin_addr.s_addr = INADDR_BROADCAST

        let sent = packet.withUnsafeBytes { rawBuf in
            withUnsafePointer(to: &addr) { addrPtr in
                addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
                    sendto(sock, rawBuf.baseAddress, packet.count, 0, saPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }

        if sent == packet.count {
            print("Wake-on-LAN magic packet (\(sent) bytes) broadcast to \(mac)")
        } else {
            print("Failed to send Wake-on-LAN magic packet")
        }
    }

    static func printUsage() {
        print("""
        Usage:
          homebridge-trinnov [options]

        Options:
          --probe                   Probe ICMP ping and TCP automation port (default mode)
          --status, -s              Query current volume, active profile, and preset labels
          --monitor, -M             Monitor live Trinnov ASCII automation events
          --wake, -w                Broadcast a Wake-on-LAN magic packet (requires --mac)
          --host, -H <host>         Trinnov Altitude IPv4 address or hostname
          --port, -p <port>         Trinnov TCP automation port (default: 44100)
          --mac, -m <mac>           Trinnov MAC address for Wake-on-LAN (e.g. 00:1E:06:12:34:56)
          --client, -c <name>       Automation client identifier (default: HomebridgeCLI)
          --help, -h                Show this help message

        Homebridge Plugin Note:
          The Homebridge plugin source is located in the root repository (src/ & dist/).
          Press Cmd+B in Xcode to compile TypeScript (src/ -> dist/) and build this tool.
        """)
    }
}

TrinnovDiagnosticCLI.run()
