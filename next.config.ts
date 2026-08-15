import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Media work happens in Node subprocesses (FFmpeg) inside route handlers, and
  // uploads stream straight to disk — so no bundler or body-size tuning is
  // needed here. Kept minimal on purpose.
};

export default config;
