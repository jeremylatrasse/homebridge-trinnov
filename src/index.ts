import { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { TrinnovAltitudePlatform } from './platform';

/**
 * Entry point for Homebridge to load the plugin.
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, TrinnovAltitudePlatform);
};
