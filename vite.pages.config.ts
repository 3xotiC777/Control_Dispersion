import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "github-pages",
  base: "/Control_Dispersion/",
  plugins: [react()],
  resolve: {
    alias: {
      "next/dynamic": fileURLToPath(new URL("./github-pages/next-dynamic-shim.tsx", import.meta.url)),
    },
  },
  build: {
    outDir: "../github-pages-dist",
    emptyOutDir: true,
  },
});
