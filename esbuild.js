const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

async function main() {
    fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });

    const ctx = await esbuild.context({
        entryPoints: ["src/extension.ts"],
        bundle: true,
        outfile: "dist/extension.js",
        external: ["vscode"],
        format: "cjs",
        platform: "node",
        target: "node18",
        minify: isProduction,
        sourcemap: !isProduction,
        sourcesContent: false,
        logLevel: "info",
    });

    if (isWatch) {
        await ctx.watch();
        console.log("Watching for changes...");
    } else {
        await ctx.rebuild();
        await ctx.dispose();

        // Test bundling removed – test files deleted

        console.log(`Build complete (${isProduction ? "production" : "development"}).`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
