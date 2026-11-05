import type { CapacitorConfig } from '@capacitor/cli'

/**
 * iOS wrapper for Trakr.
 *
 * The app talks to the API with a login cookie, so the iOS shell loads the live site over HTTPS
 * (same origin as the API) rather than bundling the files and calling the server cross-origin.
 * Set CAP_SERVER_URL to the production address before `npx cap sync ios`, for example
 * `CAP_SERVER_URL=https://trakr.example.com`. Without it the shell has nothing to load and the build fails.
 */
const serverUrl = process.env.CAP_SERVER_URL
if (!serverUrl || !/^https:\/\//.test(serverUrl)) {
  throw new Error('Set CAP_SERVER_URL to the production https:// address before building the iOS app.')
}

const config: CapacitorConfig = {
  appId: 'com.trakr.app',
  appName: 'Trakr',
  webDir: 'dist',
  server: {
    url: serverUrl,
    cleartext: false,
  },
  ios: {
    contentInset: 'automatic',
    scheme: 'Trakr',
  },
}

export default config
