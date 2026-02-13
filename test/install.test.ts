import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Integration tests for install.sh
 *
 * These tests run the actual install script in an isolated temp directory
 * by overriding HOME so that ~/.config/opencode is sandboxed.
 */

const INSTALL_SCRIPT = join(process.cwd(), 'install.sh');

// Create an isolated HOME for each test so we don't touch real config
function makeTempHome(): string {
  const dir = join(tmpdir(), `opencode-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runInstall(home: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [INSTALL_SCRIPT], {
    env: {
      ...process.env,
      HOME: home,
      // Ensure PATH includes bun
      PATH: process.env.PATH || '',
      ...env,
    },
    timeout: 60_000,
    encoding: 'utf-8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('install.sh', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = makeTempHome();
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('creates plugin directory and downloads all plugins', () => {
    const { status, stdout, stderr } = runInstall(tempHome);
    const output = stdout + stderr;

    expect(status).toBe(0);

    // Check plugin directory exists
    const pluginDir = join(tempHome, '.config', 'opencode', 'plugin');
    expect(existsSync(pluginDir)).toBe(true);

    // Check all plugin files were downloaded
    const expectedPlugins = ['reflection-3.ts', 'tts.ts', 'telegram.ts', 'worktree.ts'];
    for (const plugin of expectedPlugins) {
      const pluginPath = join(pluginDir, plugin);
      expect(existsSync(pluginPath)).toBe(true);
      // Files should have non-trivial content (not empty)
      const content = readFileSync(pluginPath, 'utf-8');
      expect(content.length).toBeGreaterThan(100);
    }
  }, 60_000);

  test('creates package.json with required dependencies', () => {
    const { status } = runInstall(tempHome);
    expect(status).toBe(0);

    const packageJsonPath = join(tempHome, '.config', 'opencode', 'package.json');
    expect(existsSync(packageJsonPath)).toBe(true);

    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies['@supabase/supabase-js']).toBeDefined();
  }, 60_000);

  test('merges into existing package.json without overwriting', () => {
    // Pre-create a package.json with existing real dependencies
    const configDir = join(tempHome, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const packageJsonPath = join(configDir, 'package.json');
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: {
        '@opencode-ai/plugin': '1.1.65',
      },
    }, null, 2));

    const { status } = runInstall(tempHome);
    expect(status).toBe(0);

    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    // Existing deps should be preserved
    expect(pkg.dependencies['@opencode-ai/plugin']).toBe('1.1.65');
    // Required dep should be added
    expect(pkg.dependencies['@supabase/supabase-js']).toBeDefined();
  }, 60_000);

  test('is idempotent (running twice succeeds)', () => {
    const result1 = runInstall(tempHome);
    expect(result1.status).toBe(0);

    const result2 = runInstall(tempHome);
    expect(result2.status).toBe(0);

    // Plugins should still exist
    const pluginDir = join(tempHome, '.config', 'opencode', 'plugin');
    expect(existsSync(join(pluginDir, 'reflection-3.ts'))).toBe(true);
  }, 120_000);

  test('installs node_modules via bun', () => {
    const { status } = runInstall(tempHome);
    expect(status).toBe(0);

    const nodeModulesDir = join(tempHome, '.config', 'opencode', 'node_modules');
    expect(existsSync(nodeModulesDir)).toBe(true);

    // Supabase should be installed
    const supabaseDir = join(nodeModulesDir, '@supabase', 'supabase-js');
    expect(existsSync(supabaseDir)).toBe(true);
  }, 60_000);

  test('prints success message with plugin list', () => {
    const { status, stdout, stderr } = runInstall(tempHome);
    const output = stdout + stderr;

    expect(status).toBe(0);
    expect(output).toContain('Installation complete');
    expect(output).toContain('reflection-3.ts');
    expect(output).toContain('tts.ts');
    expect(output).toContain('telegram.ts');
    expect(output).toContain('worktree.ts');
  }, 60_000);
});
