import { describe, expect, it } from "vitest";

import { detectEditorLanguage } from "./editor-language";

describe("detectEditorLanguage", () => {
  it("maps common remote file extensions to Monaco language ids", () => {
    expect(detectEditorLanguage("/etc/app/config.yml")).toBe("yaml");
    expect(detectEditorLanguage("/opt/app/package.json")).toBe("json");
    expect(detectEditorLanguage("/root/deploy.sh")).toBe("shell");
    expect(detectEditorLanguage("/srv/app/main.py")).toBe("python");
    expect(detectEditorLanguage("/srv/app/index.tsx")).toBe("typescript");
    expect(detectEditorLanguage("/srv/README.md")).toBe("markdown");
  });

  it("falls back to ini for config formats Monaco has no grammar for", () => {
    expect(detectEditorLanguage("/app/Cargo.toml")).toBe("ini");
    expect(detectEditorLanguage("/etc/nginx/nginx.conf")).toBe("ini");
  });

  it("recognises extensionless and dot files by name", () => {
    expect(detectEditorLanguage("/app/Dockerfile")).toBe("dockerfile");
    expect(detectEditorLanguage("/app/Dockerfile.prod")).toBe("dockerfile");
    expect(detectEditorLanguage("/root/.bashrc")).toBe("shell");
    expect(detectEditorLanguage("/app/.env")).toBe("ini");
  });

  it("ignores extension case", () => {
    expect(detectEditorLanguage("/app/CONFIG.YAML")).toBe("yaml");
  });

  it("uses plaintext for unknown or missing paths", () => {
    expect(detectEditorLanguage("/var/log/syslog")).toBe("plaintext");
    expect(detectEditorLanguage("/tmp/output.log")).toBe("plaintext");
    expect(detectEditorLanguage("")).toBe("plaintext");
    expect(detectEditorLanguage(null)).toBe("plaintext");
  });
});
