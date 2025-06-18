import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigManager } from "../src/utils/config.js";
import fs from "fs/promises";
import chokidar from "chokidar";
import { EventEmitter } from "events";
import path from "path"; // For potential temp file paths, though using fixed path for now
import commentJson from "comment-json";

// Mock chokidar
vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => {
      const watcher = new EventEmitter();
      watcher.close = vi.fn();
      return watcher;
    }),
  },
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("ConfigManager", () => {
  let configManager;
  const validConfig = {
    mcpServers: {
      test: {
        command: "node",
        args: ["server.js"],
        env: { PORT: "3000" },
      },
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (configManager) {
      configManager.stopWatching();
    }
  });

  describe("constructor", () => {
    it("should initialize with config object", () => {
      configManager = new ConfigManager(validConfig);
      expect(configManager.getConfig()).toEqual(validConfig);
    });

    it("should initialize with config path", () => {
      configManager = new ConfigManager("/path/to/config.json");
      expect(configManager.configPath).toBe("/path/to/config.json");
    });
  });

  describe("loadConfig", () => {
    it("should load and validate config from file", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(validConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await configManager.loadConfig();

      expect(configManager.getConfig()).toEqual({
        ...validConfig,
        mcpServers: {
          test: {
            ...validConfig.mcpServers.test,
            type: "stdio"
          }
        }
      });
      expect(fs.readFile).toHaveBeenCalledWith("/path/to/config.json", "utf-8");
    });

    it("should throw error if no config path specified", async () => {
      configManager = new ConfigManager();
      await expect(configManager.loadConfig()).rejects.toThrow(
        "No config path specified"
      );
    });

    it("should throw error for invalid config structure", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({ invalid: "config" })
      );

      configManager = new ConfigManager("/path/to/config.json");
      await expect(configManager.loadConfig()).rejects.toThrow(
        "Missing or invalid mcpServers configuration"
      );
    });

    it("should throw error for server missing command", async () => {
      const invalidConfig = {
        mcpServers: {
          test: {
            args: [],
          },
        },
      };
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await expect(configManager.loadConfig()).rejects.toThrow(
        "Server 'test' must include either command (for stdio) or url (for sse)"
      );
    });

    it("should set default empty array for missing args", async () => {
      const configWithoutArgs = {
        mcpServers: {
          test: {
            command: "node",
          },
        },
      };
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify(configWithoutArgs)
      );

      configManager = new ConfigManager("/path/to/config.json");
      await configManager.loadConfig();

      expect(configManager.getServerConfig("test").args).toEqual([]);
    });

    it("should throw error for invalid env", async () => {
      const invalidConfig = {
        mcpServers: {
          test: {
            command: "node",
            env: "invalid",
          },
        },
      };
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await expect(configManager.loadConfig()).rejects.toThrow(
        "Server 'test' has invalid environment config"
      );
    });

    it("should load config from file with comments", async () => {
      const configWithCommentsPath = "tests/fixtures/config-with-comments.json";
      // We don't need to mock readFile here as we want to test the actual file reading and comment stripping
      // const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValue(configContentWithComments);

      configManager = new ConfigManager(configWithCommentsPath);
      await configManager.loadConfig();

      const expectedConfig = {
        mcpServers: {
          server1: {
            command: "node",
            args: ["server.js"],
            env: {
              PORT: "3000",
            },
            disabled: false,
            dev: {
              enabled: true,
              watch: ["src/**/*.js"],
              cwd: "/path/to/project",
            },
            type: "stdio",
          },
        },
      };

      expect(configManager.getConfig()).toEqual(expectedConfig);
      // expect(readFileSpy).toHaveBeenCalledWith(configWithCommentsPath, "utf-8");
    });

    describe("dev field validation", () => {
      it("should accept valid dev config for stdio servers", async () => {
        const validDevConfig = {
          mcpServers: {
            test: {
              command: "node",
              args: ["server.js"],
              dev: {
                enabled: true,
                watch: ["src/**/*.js"],
                cwd: "/absolute/path/to/server"
              }
            }
          }
        };
        vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(validDevConfig));

        configManager = new ConfigManager("/path/to/config.json");
        await configManager.loadConfig();

        expect(configManager.getServerConfig("test").dev).toEqual(validDevConfig.mcpServers.test.dev);
      });

      it("should throw error for dev config on remote servers", async () => {
        const invalidDevConfig = {
          mcpServers: {
            test: {
              url: "https://example.com/mcp",
              dev: {
                enabled: true,
                cwd: "/some/path"
              }
            }
          }
        };
        vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidDevConfig));

        configManager = new ConfigManager("/path/to/config.json");
        await expect(configManager.loadConfig()).rejects.toThrow(
          "Server 'test' dev field is only supported for stdio servers"
        );
      });

      it("should throw error for non-object dev config", async () => {
        const invalidDevConfig = {
          mcpServers: {
            test: {
              command: "node",
              dev: "invalid-dev-config"
            }
          }
        };
        vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidDevConfig));

        configManager = new ConfigManager("/path/to/config.json");
        await expect(configManager.loadConfig()).rejects.toThrow(
          "Server 'test' dev.cwd must be an absolute path"
        );
      });

      it("should throw error for missing cwd in dev config", async () => {
        const invalidDevConfig = {
          mcpServers: {
            test: {
              command: "node",
              dev: {
                enabled: true,
                watch: ["src/**/*.js"]
                // missing cwd
              }
            }
          }
        };
        vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidDevConfig));

        configManager = new ConfigManager("/path/to/config.json");
        await expect(configManager.loadConfig()).rejects.toThrow(
          "Server 'test' dev.cwd must be an absolute path"
        );
      });

      it("should throw error for relative cwd path", async () => {
        const invalidDevConfig = {
          mcpServers: {
            test: {
              command: "node",
              dev: {
                enabled: true,
                cwd: "relative/path"
              }
            }
          }
        };
        vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidDevConfig));

        configManager = new ConfigManager("/path/to/config.json");
        await expect(configManager.loadConfig()).rejects.toThrow(
          "Server 'test' dev.cwd must be an absolute path"
        );
      });

      it("should throw error for invalid watch patterns", async () => {
        const invalidDevConfig = {
          mcpServers: {
            test: {
              command: "node",
              dev: {
                enabled: true,
                watch: "not-an-array",
                cwd: "/absolute/path"
              }
            }
          }
        };
        vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(invalidDevConfig));

        configManager = new ConfigManager("/path/to/config.json");
        await expect(configManager.loadConfig()).rejects.toThrow(
          "Server 'test' dev.watch must be an array of strings"
        );
      });

      it("should accept dev config without debounce (uses internal default)", async () => {
        const validDevConfig = {
          mcpServers: {
            test: {
              command: "node",
              dev: {
                enabled: true,
                cwd: "/absolute/path"
              }
            }
          }
        };
        vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(validDevConfig));

        configManager = new ConfigManager("/path/to/config.json");
        const result = await configManager.loadConfig();

        expect(result.config.mcpServers.test.dev.enabled).toBe(true);
        expect(result.config.mcpServers.test.dev.cwd).toBe("/absolute/path");
      });
    });
  });

  describe("watchConfig", () => {
    it("should start watching config file", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();

      expect(chokidar.watch).toHaveBeenCalledWith(
        "/path/to/config.json",
        expect.objectContaining({
          awaitWriteFinish: expect.any(Object),
          persistent: true,
          usePolling: false,
          ignoreInitial: true
        })
      );
    });

    it("should not create multiple watchers", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();
      configManager.watchConfig();

      expect(chokidar.watch).toHaveBeenCalledTimes(1);
    });

    it("should handle watch errors", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();

      const watcher = chokidar.watch.mock.results[0].value;
      const error = new Error("Watch error");

      watcher.emit("error", error);
      // Should not throw, just log the error
    });
  });

  describe("updateConfig", () => {
    it("should update config with new path", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify(validConfig));

      configManager = new ConfigManager("/path/to/config.json");
      await configManager.updateConfig("/path/to/new-config.json");

      expect(configManager.configPath).toBe("/path/to/new-config.json");
      expect(configManager.getConfig()).toEqual({
        ...validConfig,
        mcpServers: {
          test: {
            ...validConfig.mcpServers.test,
            type: "stdio"
          }
        }
      });
    });
  });

  describe("getServerConfig", () => {
    it("should return specific server config", () => {
      const testConfig = JSON.parse(JSON.stringify(validConfig)); // Deep clone to avoid mutation
      configManager = new ConfigManager(testConfig);
      expect(configManager.getServerConfig("test")).toEqual(
        validConfig.mcpServers.test
      );
    });

    it("should return undefined for non-existent server", () => {
      const testConfig = JSON.parse(JSON.stringify(validConfig)); // Deep clone to avoid mutation
      configManager = new ConfigManager(testConfig);
      expect(configManager.getServerConfig("non-existent")).toBeUndefined();
    });
  });

  describe("stopWatching", () => {
    it("should close watcher if exists", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.watchConfig();

      const watcher = chokidar.watch.mock.results[0].value;
      configManager.stopWatching();

      expect(watcher.close).toHaveBeenCalled();
    });

    it("should do nothing if no watcher exists", () => {
      configManager = new ConfigManager("/path/to/config.json");
      configManager.stopWatching();
    });
  });

  describe("saveConfig", () => {
    const tempConfigPath = "tests/fixtures/temp-config-save.json";
    const initialCommentedConfigPath = "tests/fixtures/config-with-comments.json";

    const expectedCleanConfigObject = { //This is config-with-comments.json without comments
      mcpServers: {
        server1: {
          command: "node",
          args: ["server.js"],
          env: {
            PORT: "3000",
          },
          disabled: false,
          dev: {
            enabled: true,
            watch: ["src/**/*.js"],
            cwd: "/path/to/project",
          },
          // type: "stdio", // Type is added by loadConfig, not present in original file
        },
      },
    };
     const expectedCleanConfigObjectWithType = { //This is config-with-comments.json without comments but with type
      mcpServers: {
        server1: {
          ...expectedCleanConfigObject.mcpServers.server1,
          type: "stdio",
        },
      },
    };


    afterEach(async () => {
      // Clean up the temporary file
      try {
        await fs.unlink(tempConfigPath);
      } catch (error) {
        // Ignore if file doesn't exist (e.g., test failed before creating it)
        if (error.code !== "ENOENT") {
          console.error("Error cleaning up temp file:", error);
        }
      }
    });

    it("should save the current configuration (including comment symbols) to a specified path", async () => {
      // 1. Load a config. this.config will have comment symbols from comment-json.parse()
      configManager = new ConfigManager(initialCommentedConfigPath);
      const { config: loadedConfigWithSymbols } = await configManager.loadConfig();

      // 2. Save this internal config (which has symbols) to a new temporary file
      await configManager.saveConfig(loadedConfigWithSymbols, tempConfigPath);

      // 3. Read the content of the temporary file
      const savedRawContent = await fs.readFile(tempConfigPath, "utf-8");

      // 4. Parse it again
      const reParsedConfig = commentJson.parse(savedRawContent);

      // 5. Assert that the re-parsed object is deep equal to the config object that was saved (which had symbols)
      // .toEqual typically ignores symbol properties in deep equality checks, focusing on data.
      // This effectively checks that the data part is preserved.
      expect(reParsedConfig).toEqual(loadedConfigWithSymbols);

      // Convert the loadedConfigWithSymbols (which has type added) to its string form as expected to be saved
      const expectedSavedString = commentJson.stringify(loadedConfigWithSymbols, null, 2);

      // 6. Assert that the raw file content is exactly what commentJson.stringify produced,
      // including comments, because loadedConfigWithSymbols contained the comment symbols.
      expect(savedRawContent).toEqual(expectedSavedString);
    });

    it("should save a given (clean) configuration object to the default path", async () => {
      configManager = new ConfigManager(tempConfigPath); // Set up with default path

      // Here, we save an object that does NOT have comment symbols (it's a plain object)
      await configManager.saveConfig(expectedCleanConfigObjectWithType);

      const savedContent = await fs.readFile(tempConfigPath, "utf-8");
      const parsedSavedContent = commentJson.parse(savedContent); // or JSON.parse

      // It should be equal to the plain object we saved
      expect(parsedSavedContent).toEqual(expectedCleanConfigObjectWithType);
      // And the string output should be a clean JSON string without comments
      expect(savedContent).toEqual(commentJson.stringify(expectedCleanConfigObjectWithType, null, 2));
    });


    it("should throw error if no config path specified and not provided", async () => {
      configManager = new ConfigManager({}); // Initialized with an object, no default path
      await expect(
        configManager.saveConfig(expectedCleanConfigObject)
      ).rejects.toThrow(
        "No config path specified for saving. Initialize ConfigManager with a path or provide it to saveConfig."
      );
    });

    it("should throw error for invalid config object", async () => {
      configManager = new ConfigManager(tempConfigPath);
      await expect(
        configManager.saveConfig(null, tempConfigPath)
      ).rejects.toThrow("Invalid configuration object provided.");
      await expect(
        configManager.saveConfig("not-an-object", tempConfigPath)
      ).rejects.toThrow("Invalid configuration object provided.");
    });
  });
});
