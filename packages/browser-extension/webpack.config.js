// packages/browser-extension/webpack.config.js
// Multi-entry MV3 bundle for the Oweibo browser extension (v9.5.9).
//
//   background.js    ← service worker; imports bridge, content engine, HITL
//   content-script.js← injected by ContentScriptActionEngine
//   hitl-overlay.js  ← injected by InTabHITLOverlay
//   popup.js         ← popup/popup.ts
//   pair.js          ← deep-link pairing page
//
// Static assets (manifest.json, *.html, icons) are copied by scripts/copy-static.mjs
// which is wired into the `build` npm script; keeping it out of webpack keeps the
// dependency surface small (no copy-webpack-plugin).

'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  devtool: process.env.NODE_ENV === 'production' ? false : 'inline-source-map',
  target: 'web',

  entry: {
    background:       './src/background.ts',
    'content-script': './src/content/content-script.ts',
    'hitl-overlay':   './src/content/hitl-overlay.ts',
    'popup/popup':    './src/popup/popup.ts',
    pair:             './src/pair.ts',
  },

  output: {
    path: path.resolve(__dirname, 'build'),
    filename: '[name].js',
    clean: true,
    // MV3 service workers can't use chunked output, so inline everything per entry.
    chunkFormat: false,
  },

  resolve: {
    extensions: ['.ts', '.js'],
    // Strip the `.js` suffix on relative .ts imports (NodeNext-style) so webpack
    // can resolve them against the .ts source.
    extensionAlias: { '.js': ['.ts', '.js'] },
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true, // type-check runs separately via `npm run type-check`
              compilerOptions: { module: 'ES2022', moduleResolution: 'bundler' },
            },
          },
        ],
        exclude: /node_modules/,
      },
    ],
  },

  // MV3 service workers run in their own realm — no code splitting, no dynamic import.
  optimization: { splitChunks: false, runtimeChunk: false },

  performance: { hints: false },
};
