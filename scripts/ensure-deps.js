#!/usr/bin/env node
/**
 * Ensures required dependencies are present in ~/.config/opencode/package.json
 * OpenCode runs `bun install` at startup to install these dependencies.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.config', 'opencode');
const PACKAGE_JSON_PATH = join(CONFIG_DIR, 'package.json');

// Dependencies required by our plugins
const REQUIRED_DEPS = {
  '@supabase/supabase-js': '^2.49.0',
  '@sentry/node': '^9.0.0'
};

// Minimum stable version for @opencode-ai/plugin
// Pre-release versions like 0.0.0-main-* are written by dev builds and often
// get unpublished, breaking `bun install`. This fallback fixes that.
const PLUGIN_PKG = '@opencode-ai/plugin';
const PLUGIN_STABLE_VERSION = '^1.2.1';

/**
 * Returns true if the version string looks like an unstable/pre-release version
 * that may not exist in the registry (e.g. "0.0.0-main-202602141024").
 */
function isUnstablePluginVersion(version) {
  if (!version || typeof version !== 'string') return true;
  // Pre-release tags like 0.0.0-main-*, 0.0.0-dev-*, 0.0.0-canary-*
  if (/^0\.0\.0-/.test(version)) return true;
  // Exact pinned pre-release (no ^ or ~ prefix) with hyphen tag
  if (!/^[\^~]/.test(version) && /-/.test(version)) return true;
  return false;
}

function ensureDeps() {
  // Ensure config directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Read existing package.json or create default
  let pkg = { dependencies: {} };
  if (existsSync(PACKAGE_JSON_PATH)) {
    try {
      pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      if (!pkg.dependencies) {
        pkg.dependencies = {};
      }
    } catch (e) {
      console.error('Warning: Could not parse existing package.json, creating new one');
      pkg = { dependencies: {} };
    }
  }

  // Add required dependencies if missing
  let updated = false;
  for (const [name, version] of Object.entries(REQUIRED_DEPS)) {
    if (!pkg.dependencies[name]) {
      pkg.dependencies[name] = version;
      updated = true;
      console.log(`Added dependency: ${name}@${version}`);
    }
  }

  // Fix broken @opencode-ai/plugin versions (e.g. 0.0.0-main-* from dev builds)
  const currentPluginVersion = pkg.dependencies[PLUGIN_PKG];
  if (currentPluginVersion && isUnstablePluginVersion(currentPluginVersion)) {
    console.log(`Fixing broken ${PLUGIN_PKG} version: ${currentPluginVersion} → ${PLUGIN_STABLE_VERSION}`);
    pkg.dependencies[PLUGIN_PKG] = PLUGIN_STABLE_VERSION;
    updated = true;
  }

  // Write back if updated
  if (updated) {
    writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Updated ${PACKAGE_JSON_PATH}`);
  } else {
    console.log('All required dependencies already present');
  }
}

ensureDeps();
