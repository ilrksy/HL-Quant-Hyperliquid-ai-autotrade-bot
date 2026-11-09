// runs the bundled self-hosted server as an electron utility process so a desktop pc can be the main server
import { utilityProcess } from "electron";
import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

// rotate the server log past this size so a long-running host cannot fill the disk
const MAX_LOG_BYTES = 10 * 1024 * 1024;
// cold starts may migrate data and fetch market metadata before the server listens
const HEALTH_TIMEOUT_MS = 45_000;
// crash restarts back off up to this delay so a broken config does not spin the cpu
const MAX_RESTART_DELAY_MS = 30_000;

// resolves after the given delay; used between health probes
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// true when the port can be bound on that interface, so host mode never collides with another server
function canListen(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

// first bindable port at or above the preferred one, so a docker server already on 8787 does not block host mode
async function findFreePort(preferred, host) {
  for (let port = preferred; port < preferred + 20 && port < 65536; port++) if (await canListen(port, host)) return port;
  throw new Error(`ports ${preferred}-${preferred + 19} are all in use`);
}

// owns one server child: picks a port, starts it, waits for /api/health, restarts it after crashes and stops it on quit
export class HostServer {
  // bundle and webDist come from the packaged resources; dataDir and logDir live in the user's profile
  constructor({ bundle, webDist, dataDir, logDir, onChange = () => {} }) {
    Object.assign(this, { bundle, webDist, dataDir, logDir, onChange });
    this.child = null;
    this.ready = false;
    this.wanted = false;
    this.port = null;
    this.opts = null;
    this.recent = "";
    this.backoff = 1000;
    this.upSince = 0;
    this.restartTimer = null;
    this.stream = null;
  }

  // true while the server answers health checks
  get running() {
    return this.ready && this.child !== null;
  }

  // loopback url the local window uses, whatever interface the server binds
  get localUrl() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  // last lines of server output, shown when a start fails
  tail(lines = 25) {
    return this.recent.split("\n").filter(Boolean).slice(-lines).join("\n");
  }

  // appends to logs/server.log and the in-memory tail, rotating the file once it grows too large
  write(text) {
    if (!this.stream) {
      mkdirSync(this.logDir, { recursive: true });
      const file = join(this.logDir, "server.log");
      try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
      } catch {
        // no previous log yet
      }
      this.stream = createWriteStream(file, { flags: "a" });
    }
    this.stream.write(text);
    this.recent = (this.recent + text).slice(-16_000);
  }

  // desktop-side lifecycle line in the same log as the server output
  note(message) {
    this.write(`${new Date().toISOString()} [desktop] ${message}\n`);
  }

  // starts the server and resolves once /api/health answers; throws (and cleans up) if it never does
  async start({ host, port, token }) {
    clearTimeout(this.restartTimer);
    this.opts = { host, token };
    this.wanted = true;
    this.backoff = 1000;
    try {
      this.port = await findFreePort(port, host);
      if (this.port !== port) this.note(`port ${port} is busy, using ${this.port}`);
      await this.launch();
    } catch (error) {
      this.note(`start failed: ${error.message}`);
      await this.stop();
      throw error;
    }
  }

  // forks one server process and waits for it to become healthy
  async launch() {
    const child = this.spawn();
    try {
      await this.waitForHealth(child);
    } catch (error) {
      if (this.child === child) child.kill();
      throw error;
    }
    this.ready = true;
    this.upSince = Date.now();
    this.note(`server ready on ${this.opts.host}:${this.port}`);
    this.onChange();
  }

  // forks the bundled server with the host-mode environment contract (DATA_DIR, WEB_DIST, HOST, PORT, API_TOKEN, ENV_FILE)
  spawn() {
    mkdirSync(this.dataDir, { recursive: true });
    const env = {
      ...process.env,
      NODE_ENV: "production",
      HOST: this.opts.host,
      PORT: String(this.port),
      API_TOKEN: this.opts.token,
      DATA_DIR: this.dataDir,
      WEB_DIST: this.webDist,
      ENV_FILE: join(this.dataDir, ".env"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    this.note(`starting ${this.bundle} on ${this.opts.host}:${this.port}`);
    const child = utilityProcess.fork(this.bundle, [], { serviceName: "HL Quant Server", cwd: this.dataDir, stdio: "pipe", env });
    child.stdout?.on("data", (chunk) => this.write(chunk.toString()));
    child.stderr?.on("data", (chunk) => this.write(chunk.toString()));
    child.once("exit", (code) => this.onExit(child, code));
    this.child = child;
    this.ready = false;
    return child;
  }

  // polls /api/health until it answers ok, the child dies or the timeout passes
  async waitForHealth(child) {
    const url = `${this.localUrl}/api/health`;
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child !== child) throw new Error("the server process exited during startup");
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok === true) return;
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    throw new Error(`no answer from ${url} within ${HEALTH_TIMEOUT_MS / 1000}s`);
  }

  // records the exit and restarts a crashed server with backoff while host mode is still wanted
  onExit(child, code) {
    if (this.child !== child) return;
    const wasReady = this.ready;
    this.child = null;
    this.ready = false;
    this.note(`server exited with code ${code}`);
    this.onChange();
    if (this.wanted && wasReady) this.scheduleRestart();
  }

  // retries launch after a delay that grows on repeated failures and resets after a stable minute
  scheduleRestart() {
    this.backoff = Date.now() - this.upSince > 60_000 ? 1000 : Math.min(this.backoff * 2, MAX_RESTART_DELAY_MS);
    this.note(`restarting in ${this.backoff / 1000}s`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.wanted) return;
      this.launch().catch((error) => {
        this.note(`restart failed: ${error.message}`);
        if (this.wanted) this.scheduleRestart();
      });
    }, this.backoff);
  }

  // stops the server (SIGTERM on posix so it can flush), waiting up to five seconds for it to exit
  async stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.ready = false;
    if (child) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
      if (this.child === child) this.child = null;
      this.note("server stopped");
    }
    this.onChange();
  }
}
