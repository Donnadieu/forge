import { describe, it, expect } from "vitest";
import { buildSshArgs, shellEscape } from "../../../src/workspace/ssh.js";

describe("SSH utilities", () => {
  describe("shellEscape", () => {
    it("wraps a simple string in single quotes", () => {
      expect(shellEscape("hello")).toBe("'hello'");
    });

    it("escapes single quotes within the string", () => {
      expect(shellEscape("it's")).toBe("'it'\\''s'");
    });

    it("handles multiple single quotes", () => {
      expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
    });

    it("handles empty string", () => {
      expect(shellEscape("")).toBe("''");
    });

    it("handles strings with spaces and special chars", () => {
      const result = shellEscape("echo $HOME && rm -rf /");
      expect(result).toBe("'echo $HOME && rm -rf /'");
    });

    it("handles strings with double quotes", () => {
      expect(shellEscape('say "hello"')).toBe("'say \"hello\"'");
    });
  });

  describe("buildSshArgs", () => {
    it("builds args for a plain host", () => {
      const args = buildSshArgs("myhost");
      expect(args).toEqual(["-T", "myhost"]);
    });

    it("builds args for user@host format", () => {
      const args = buildSshArgs("deploy@prod-server");
      expect(args).toEqual(["-T", "deploy@prod-server"]);
    });

    it("extracts port from host:port format", () => {
      const args = buildSshArgs("myhost:2222");
      expect(args).toEqual(["-T", "-p", "2222", "myhost"]);
    });

    it("extracts port from user@host:port format", () => {
      const args = buildSshArgs("deploy@myhost:2222");
      expect(args).toEqual(["-T", "-p", "2222", "deploy@myhost"]);
    });

    it("does not treat non-numeric suffix as port", () => {
      const args = buildSshArgs("myhost:abc");
      expect(args).toEqual(["-T", "myhost:abc"]);
    });

    it("includes -F flag when sshConfigPath is provided", () => {
      const args = buildSshArgs("myhost", "/home/user/.ssh/custom_config");
      expect(args).toEqual(["-T", "-F", "/home/user/.ssh/custom_config", "myhost"]);
    });

    it("includes -F flag with host:port format", () => {
      const args = buildSshArgs("myhost:3333", "/custom/ssh_config");
      expect(args).toEqual(["-T", "-F", "/custom/ssh_config", "-p", "3333", "myhost"]);
    });

    it("always includes -T for non-interactive mode", () => {
      const args = buildSshArgs("anyhost");
      expect(args[0]).toBe("-T");
    });
  });
});
