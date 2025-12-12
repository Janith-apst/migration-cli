import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const appName = pkg.name || 'migration-cli';

const osMap = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const archMap = { x64: 'x64', arm64: 'arm64' };

const osName = osMap[process.platform];
const archName = archMap[process.arch];
if (!osName) throw new Error(`Unsupported platform: ${process.platform}`);
if (!archName) throw new Error(`Unsupported architecture: ${process.arch}`);

const outputDir = join(projectRoot, 'artifacts');
const stagingDir = join(tmpdir(), `${appName}-${osName}-${archName}-${Date.now()}`);

const run = (cmd, cwd = projectRoot) => execSync(cmd, { cwd, stdio: 'inherit' });
const copy = (src, dest) => cpSync(src, dest, { recursive: true });

try {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    run('pnpm install --frozen-lockfile');
    run('pnpm build');

    copy(join(projectRoot, 'dist'), join(stagingDir, 'dist'));
    copy(join(projectRoot, 'package.json'), join(stagingDir, 'package.json'));
    if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) {
        copy(join(projectRoot, 'pnpm-lock.yaml'), join(stagingDir, 'pnpm-lock.yaml'));
    }

    console.log('Installing production dependencies...');
    run('pnpm install --prod --frozen-lockfile', stagingDir);

    if (!existsSync(join(stagingDir, 'node_modules'))) {
        throw new Error('node_modules not created in staging directory');
    }
    console.log('Dependencies installed successfully');

    const ext = osName === 'windows' ? 'zip' : 'tar.gz';
    const artifactName = `${appName}-${osName}-${archName}.${ext}`;
    const artifactPath = join(outputDir, artifactName);

    rmSync(artifactPath, { force: true });
    rmSync(`${artifactPath}.sha256`, { force: true });

    if (osName === 'windows') {
        const winArtifactPath = artifactPath.replace(/\\/g, '/');
        run(`powershell -NoProfile -Command "Compress-Archive -Path './*' -DestinationPath '${winArtifactPath}' -Force"`, stagingDir);
    } else {
        run(`tar -czf "${artifactPath}" -C "${stagingDir}" .`);
    }

    const hash = crypto.createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    writeFileSync(`${artifactPath}.sha256`, `${hash}  ${artifactName}\n`, 'utf8');

    console.log(`Built ${artifactPath}`);
    console.log(`SHA256 ${hash}`);
} finally {
    rmSync(stagingDir, { recursive: true, force: true });
}
