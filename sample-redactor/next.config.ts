import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const root = process.cwd();   // this project, never a parent monorepo folder

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  // ffmpeg-static resolves its binary path at runtime; keep it external and ship the binary with every route.
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/**": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default withWorkflow(nextConfig);
