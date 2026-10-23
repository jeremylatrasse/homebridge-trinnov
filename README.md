# Homebridge Trinnov Altitude Plugin

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

A dynamic platform plugin for [Homebridge](https://homebridge.io) that gives you full native Apple HomeKit integration for the **Trinnov Altitude32** (and Altitude16) audio processor over Ethernet.

---

## Features

- **Native Apple TV / Receiver Accessory (`Service.Television` / `AUDIO_RECEIVER`):**
  - **Power Control:**
    - **Power On:** Broadcasts Wake-on-LAN (WoL) magic packets to wake the Altitude processor from standby.
    - **Power Off:** Gracefully sends standby/shutdown commands (`power_off`) over TCP automation.
  - **Volume & Mute Control:**
    - Seamless control via the iOS Control Center **Apple Remote** widget.
    - iPhone/iPad physical hardware volume rockers adjust the Altitude's master volume (`dvolume +/- 1.0 dB`).
    - Bidirectional volume synchronization between decibels (-90 dB to 0 dB) and HomeKit percentage.
    - Mute and Dim synchronization.
  - **Input Source Selection (Profiles):**
    - Directly switch Trinnov Profiles (Apple TV, Kaleidescape, Vinyl, Roon, etc.) from the Apple Home app or Siri.
    - Auto-discovery of active profiles push-reported by the Altitude over TCP.
  - **Companion Volume Slider:**
    - Optional in-room brightness-style volume slider in the Apple Home app, making volume adjustments accessible directly from room tiles without opening the remote widget.
  - **Switches & Presets:**
    - Standby / Mute / Optimizer Bypass switches.
    - One-tap recall of Trinnov Optimizer presets (e.g. Reference, Music, Late Night).

---

## Installation

1. Install Homebridge using the [official instructions](https://github.com/homebridge/homebridge).
2. Install this plugin:
   ```bash
   npm install -g homebridge-trinnov-altitude
   ```

---

## Pairing with Apple Home

Because Apple HomeKit requires Television / Receiver accessories to be exposed independently (unbridged):

1. Start Homebridge.
2. Open the **Apple Home app** on your iOS device.
3. Tap **+** in the top right corner and choose **Add Accessory**.
4. Tap **More options...** (or *Don't Have a Code or Can't Scan?*).
5. You will see your **Trinnov Altitude32** under *Nearby Accessories*.
6. Tap on it and enter your standard Homebridge PIN code (default: `031-45-154`).

---

## Configuration Example

Configure using the Homebridge UI or add the platform to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "TrinnovAltitude",
      "name": "Trinnov Altitude",
      "devices": [
        {
          "name": "Altitude32",
          "host": "192.168.1.100",
          "port": 44100,
          "mac": "00:1E:06:12:34:56",
          "minVolumeDb": -90.0,
          "maxVolumeDb": 0.0,
          "enableVolumeSlider": true,
          "enableMuteSwitch": false,
          "enableBypassSwitch": true,
          "inputs": [
            { "id": 0, "name": "Apple TV 4K", "type": "HDMI" },
            { "id": 1, "name": "Kaleidescape", "type": "HDMI" },
            { "id": 2, "name": "4K Blu-ray", "type": "HDMI" },
            { "id": 3, "name": "Turntable", "type": "AUDIO_SYSTEM" },
            { "id": 4, "name": "Roon Streamer", "type": "AUDIO_SYSTEM" }
          ],
          "presets": [
            { "id": 1, "name": "Preset: Reference" },
            { "id": 2, "name": "Preset: Music" }
          ]
        }
      ]
    }
  ]
}
```

### Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `name` | string | `Trinnov Altitude32` | Name of the processor shown in Apple Home. |
| `host` | string | **Required** | Ethernet IP address of your Trinnov Altitude processor. |
| `port` | number | `44100` | Automation TCP port (Trinnov default: 44100). |
| `mac` | string | Optional | Network MAC address of the Altitude. **Required for Wake-on-LAN power on**. |
| `minVolumeDb` | number | `-90.0` | Minimum volume in dB corresponding to 0% in HomeKit. |
| `maxVolumeDb` | number | `0.0` | Maximum volume in dB corresponding to 100% in HomeKit (protects equipment). |
| `enableVolumeSlider` | boolean | `true` | Creates a companion slider in Apple Home for in-room volume adjustments. |
| `enableBypassSwitch` | boolean | `false` | Exposes a switch to bypass the Trinnov Acoustic Optimizer. |
| `inputs` | array | Auto/Default | Array of Trinnov profiles `{ "id": 0, "name": "Apple TV", "type": "HDMI" }`. |
| `presets` | array | Optional | Array of Trinnov presets `{ "id": 1, "name": "Reference" }`. |

---

## Trinnov Automation Protocol Notes

- **Port:** `44100` over raw TCP.
- **Handshake:** Automatically identifies client via `id Homebridge`.
- **Power On:** Uses UDP broadcast Wake-on-LAN magic packet (ports 9 & 7).
- **Power Off:** Sends `power_off` and `power_off_SECURED_FHZMCH48FE` commands.
- **Volume:** `volume <dB>` and `dvolume <delta>`.
- **Inputs:** `profile <index>`.

---

## License

Apache-2.0
