import os from "node:os";
import { execSync } from "node:child_process";

export function machineInfo() {
  return {
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    os: `${os.platform()} ${os.release()}`,
    node: process.version,
  };
}

export function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}