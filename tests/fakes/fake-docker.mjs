#!/usr/bin/env node
// A fake `docker` CLI over a JSON state file, for tests. Implements the subcommands the plugin
// uses and appends every invocation to a call log.
//
// Env:
//   FAKE_DOCKER_STATE  state file: {images, containers, networks, volumes, registry}
//   FAKE_DOCKER_LOG    JSONL call log: {args, viaSudo}
//   FAKE_DOCKER_MODE   comma list: denied (refused unless via sudo), daemon-down, port-clash,
//                      crash (a run/start container exits 1), fail-<subcommand>
//   FAKE_DOCKER_VIA_SUDO  set by fake-sudo
import fs from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.FAKE_DOCKER_STATE;
const modes = new Set(String(process.env.FAKE_DOCKER_MODE ?? '').split(',').filter(Boolean));
const viaSudo = process.env.FAKE_DOCKER_VIA_SUDO === '1';
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify({ args, viaSudo })}\n`);

const load = () => {
  const s = statePath && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  return { images: {}, containers: {}, networks: {}, volumes: {}, registry: {}, ...s };
};
const save = (s) => fs.writeFileSync(statePath, JSON.stringify(s, null, 1));
const out = (s) => process.stdout.write(`${s}\n`);
const fail = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };

if (modes.has('daemon-down')) fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
if (modes.has('denied') && !viaSudo) fail('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/version": dial unix /var/run/docker.sock: connect: permission denied');

const labelsFrom = (list) => {
  const labels = {};
  for (let i = 0; i < list.length; i++) if (list[i] === '--label') { const [k, ...v] = list[++i].split('='); labels[k] = v.join('='); }
  return labels;
};
const readStdin = () => { try { return fs.readFileSync(0); } catch { return Buffer.alloc(0); } };
/** An image by reference or by ID. */
const findImage = (s, key) => s.images[key] ?? Object.values(s.images).find((i) => i.Id === key);

// Bundles are real tar archives holding one fake-images.json, so the plugin's tar handling is
// exercised; any other entry (the plugin's own manifest) is ignored, as docker load does.
function tarFile(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
function tarRead(buf) {
  const files = {};
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    files[name] = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

let [cmd, ...rest] = args;
if (cmd === 'container' && rest[0] === 'inspect') { cmd = 'inspect-container'; rest = rest.slice(1); }
if (cmd === 'image' && rest[0] === 'inspect') { cmd = 'inspect-image'; rest = rest.slice(1); }
if (cmd === 'network' || cmd === 'volume') { cmd = `${cmd}-${rest[0]}`; rest = rest.slice(1); }
if (modes.has(`fail-${cmd}`)) fail(`Error response from daemon: injected failure of ${cmd}`, 125);

const s = load();
const crashState = { Status: 'exited', Running: false, Restarting: false, ExitCode: 1 };
const runState = { Status: 'running', Running: true, Restarting: false, ExitCode: 0 };

switch (cmd) {
  case 'version': out(process.env.FAKE_DOCKER_SERVER_VERSION ?? '29.9.2'); break;
  case 'inspect-image': {
    const img = findImage(s, rest[0]);
    if (!img) fail(`Error response from daemon: No such image: ${rest[0]}`);
    out(JSON.stringify([img]));
    break;
  }
  case 'inspect-container': {
    const c = s.containers[rest[0]];
    if (!c) fail(`Error response from daemon: No such container: ${rest[0]}`);
    out(JSON.stringify([c]));
    break;
  }
  case 'network-inspect': case 'volume-inspect': {
    const coll = cmd.startsWith('network') ? s.networks : s.volumes;
    const r = coll[rest[0]];
    if (!r) fail(cmd.startsWith('network') ? `Error response from daemon: network ${rest[0]} not found` : `Error response from daemon: get ${rest[0]}: no such volume`);
    out(JSON.stringify([r]));
    break;
  }
  case 'network-create': case 'volume-create': {
    const name = rest[rest.length - 1];
    const coll = cmd.startsWith('network') ? s.networks : s.volumes;
    coll[name] = { Name: name, Labels: labelsFrom(rest) };
    save(s); out(name);
    break;
  }
  case 'volume-rm': {
    if (!s.volumes[rest[0]]) fail(`Error: No such volume: ${rest[0]}`);
    if (Object.values(s.containers).some((c) => c.Mounts?.includes(rest[0]))) fail(`Error response from daemon: remove ${rest[0]}: volume is in use`);
    delete s.volumes[rest[0]]; save(s); out(rest[0]);
    break;
  }
  case 'run': {
    if (rest.includes('--rm')) {
      // The CP build helper.
      if (rest.includes('buildx')) {
        out('#1 [internal] load git source'); out('#2 DONE');
        if (!findImage(s, rest[rest.indexOf('--rm') + 5])) fail('Unable to find image locally', 125);
        const tag = rest[rest.indexOf('-t') + 1];
        s.images[tag] = s.registry[tag] ?? { Id: `sha256:${'b'.repeat(64)}`, Config: { Labels: labelsFrom(rest.slice(rest.indexOf('buildx'))) } };
        save(s);
      }
      break;
    }
    const opt = (flag) => { const i = rest.indexOf(flag); return i === -1 ? null : rest[i + 1]; };
    const name = opt('--name');
    // The image is the first positional after the options (a command may follow it).
    const valued = new Set(['--name', '--network', '--network-alias', '--restart', '-p', '-v', '--label', '--env-file', '--security-opt', '--cap-drop', '--entrypoint']);
    let image;
    for (let i = 0; i < rest.length; i++) {
      if (!rest[i].startsWith('-')) { image = rest[i]; break; }
      if (valued.has(rest[i])) i++;
    }
    if (!findImage(s, image)) fail(`Unable to find image '${image}' locally`, 125);
    if (s.containers[name]) fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "x".`, 125);
    const envFile = opt('--env-file');
    const Env = envFile ? fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean) : [];
    const ports = []; const mounts = [];
    for (let i = 0; i < rest.length; i++) { if (rest[i] === '-p') ports.push(rest[i + 1]); if (rest[i] === '-v') mounts.push(rest[i + 1].split(':')[0]); }
    const c = { Id: `cid-${name}`, Name: `/${name}`, Image: findImage(s, image).Id, Config: { Image: image, Labels: labelsFrom(rest), Env }, Ports: ports, Mounts: mounts, Network: opt('--network'), RunArgs: rest, State: runState };
    if (modes.has('port-clash')) {
      c.State = { Status: 'created', Running: false, Restarting: false, ExitCode: 128 };
      s.containers[name] = c; save(s);
      fail(`docker: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint ${name}: Bind for ${ports[0]?.split(':').slice(0, 2).join(':')} failed: port is already allocated`, 125);
    }
    if (modes.has('crash')) c.State = crashState;
    s.containers[name] = c; save(s); out(c.Id);
    break;
  }
  case 'start': {
    const c = s.containers[rest[0]];
    if (!c) fail(`Error response from daemon: No such container: ${rest[0]}`);
    if (modes.has('port-clash')) fail('Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:18888 failed: port is already allocated');
    c.State = modes.has('crash') ? crashState : runState; save(s); out(rest[0]);
    break;
  }
  case 'stop': {
    for (const n of rest.filter((a, i) => a !== '-t' && rest[i - 1] !== '-t')) {
      if (s.containers[n]) s.containers[n].State = { Status: 'exited', Running: false, Restarting: false, ExitCode: 0 };
      out(n);
    }
    save(s);
    break;
  }
  case 'rm': {
    const n = rest.filter((a) => a !== '-f')[0];
    delete s.containers[n]; save(s); out(n);
    break;
  }
  case 'logs': out(`log line for ${rest[rest.length - 1]}`); break;
  case 'pull': {
    const img = s.registry[rest[0]];
    if (!img) fail(`Error response from daemon: pull access denied for ${rest[0]}`);
    out(`${rest[0]}: Pulling from registry`); out('Status: Downloaded newer image');
    s.images[rest[0]] = img; save(s);
    break;
  }
  case 'load': {
    let bundle;
    try { bundle = JSON.parse(tarRead(readStdin())['fake-images.json'].toString()); } catch { fail('Error: archive/tar: invalid tar header'); }
    for (const [ref, img] of Object.entries(bundle.images ?? {})) { s.images[ref] = img; out(`Loaded image: ${ref}`); }
    save(s);
    break;
  }
  case 'save': {
    const images = {};
    for (const ref of rest) { if (!s.images[ref]) fail(`Error response from daemon: reference does not exist: ${ref}`); images[ref] = s.images[ref]; }
    process.stdout.write(Buffer.concat([tarFile('fake-images.json', Buffer.from(JSON.stringify({ images }))), Buffer.alloc(1024), Buffer.alloc(8192)]));
    break;
  }
  case 'rmi': {
    for (const ref of rest) { if (!s.images[ref]) fail(`Error: No such image: ${ref}`); delete s.images[ref]; out(`Untagged: ${ref}`); }
    save(s);
    break;
  }
  default: fail(`fake docker: unsupported command ${args.join(' ')}`, 2);
}
