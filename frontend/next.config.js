/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The @mysten/* SDKs (dapp-kit, enoki, sui, wallet-standard) ship ESM that
  // Next 14 must transpile to bundle cleanly.
  transpilePackages: [
    "@mysten/dapp-kit",
    "@mysten/enoki",
    "@mysten/sui",
    "@mysten/wallet-standard",
    "@mysten/bcs",
    "@twilio/voice-sdk",
  ],
};

module.exports = nextConfig;
