import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as tar from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";

import { mockDownload, mockGetFiles } from "../__mocks__/@google-cloud/storage";
import { Events, RefKey } from "../src/constants";
import { restoreImpl } from "../src/restoreImpl";
import { StateProvider } from "../src/stateProvider";
import * as testUtils from "../src/utils/testUtils";

jest.mock("@actions/cache");
jest.mock("@actions/cache/lib/internal/cacheUtils");
jest.mock("@actions/cache/lib/internal/tar");

beforeEach(() => {
    jest.clearAllMocks();
    process.env[Events.Key] = Events.Push;
    process.env[RefKey] = "refs/heads/feature-branch";

    jest.spyOn(cacheUtils, "createTempDirectory").mockResolvedValue(
        "/tmp/cache-archive"
    );
    jest.spyOn(cacheUtils, "getCompressionMethod").mockResolvedValue(
        CompressionMethod.Gzip
    );
    jest.spyOn(cacheUtils, "getCacheFileName").mockReturnValue("cache.tgz");
    jest.spyOn(cacheUtils, "getArchiveFileSizeInBytes").mockReturnValue(100000);
    jest.spyOn(cacheUtils, "unlinkFile").mockResolvedValue();
    jest.spyOn(tar, "extractTar").mockResolvedValue();
    jest.spyOn(tar, "listTar").mockResolvedValue();
});

afterEach(() => {
    testUtils.clearInputs();
    delete process.env[Events.Key];
    delete process.env[RefKey];
});

test("GCS restore with exact key match sets cache-hit to true", async () => {
    const key = "node-test";
    testUtils.setInputs({
        path: "node_modules",
        key,
        enableCrossOsArchive: false,
        gcsBucket: "test-bucket"
    });

    mockGetFiles.mockResolvedValue([
        [
            {
                name: "github-cache/node-test.cache.tgz",
                metadata: { timeCreated: "2025-01-01T00:00:00Z" }
            }
        ]
    ]);
    mockDownload.mockResolvedValue(undefined);

    const setCacheHitOutputMock = jest.spyOn(core, "setOutput");
    const stateMock = jest.spyOn(core, "saveState");

    await restoreImpl(new StateProvider());

    expect(stateMock).toHaveBeenCalledWith("CACHE_KEY", key);
    expect(setCacheHitOutputMock).toHaveBeenCalledWith("cache-hit", "true");
});

test("GCS restore with restore key prefix match sets cache-hit to false", async () => {
    const key = "node-abc123";
    const restoreKey = "node-";
    testUtils.setInputs({
        path: "node_modules",
        key,
        restoreKeys: [restoreKey],
        enableCrossOsArchive: false,
        gcsBucket: "test-bucket"
    });

    // Primary key not found, but prefix match finds an older cache
    mockGetFiles.mockResolvedValueOnce([[]]).mockResolvedValueOnce([
        [
            {
                name: "github-cache/node-old-hash.cache.tgz",
                metadata: { timeCreated: "2025-01-01T00:00:00Z" }
            }
        ]
    ]);
    mockDownload.mockResolvedValue(undefined);

    const setCacheHitOutputMock = jest.spyOn(core, "setOutput");

    await restoreImpl(new StateProvider());

    expect(setCacheHitOutputMock).toHaveBeenCalledWith("cache-hit", "false");
});

test("GCS restore picks the latest file when multiple prefix matches exist", async () => {
    const key = "node-abc123";
    const restoreKey = "node-";
    testUtils.setInputs({
        path: "node_modules",
        key,
        restoreKeys: [restoreKey],
        enableCrossOsArchive: false,
        gcsBucket: "test-bucket"
    });

    mockGetFiles.mockResolvedValueOnce([[]]).mockResolvedValueOnce([
        [
            {
                name: "github-cache/node-older.cache.tgz",
                metadata: { timeCreated: "2025-01-01T00:00:00Z" }
            },
            {
                name: "github-cache/node-newer.cache.tgz",
                metadata: { timeCreated: "2025-06-01T00:00:00Z" }
            }
        ]
    ]);
    mockDownload.mockResolvedValue(undefined);

    const infoMock = jest.spyOn(core, "info");

    await restoreImpl(new StateProvider());

    expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining("github-cache/node-newer.cache.tgz")
    );
});

test("GCS restore returns undefined when no cache found", async () => {
    const key = "node-test";
    testUtils.setInputs({
        path: "node_modules",
        key,
        enableCrossOsArchive: false,
        gcsBucket: "test-bucket"
    });

    mockGetFiles.mockResolvedValue([[]]);

    const infoMock = jest.spyOn(core, "info");

    await restoreImpl(new StateProvider());

    expect(infoMock).toHaveBeenCalledWith(
        `Cache not found for input keys: ${key}`
    );
});

test("GCS restore with lookup-only does not download", async () => {
    const key = "node-test";
    testUtils.setInputs({
        path: "node_modules",
        key,
        enableCrossOsArchive: false,
        lookupOnly: true,
        gcsBucket: "test-bucket"
    });

    mockGetFiles.mockResolvedValue([
        [
            {
                name: "github-cache/node-test.cache.tgz",
                metadata: { timeCreated: "2025-01-01T00:00:00Z" }
            }
        ]
    ]);

    const setCacheHitOutputMock = jest.spyOn(core, "setOutput");

    await restoreImpl(new StateProvider());

    expect(mockDownload).not.toHaveBeenCalled();
    expect(setCacheHitOutputMock).toHaveBeenCalledWith("cache-hit", "true");
});
