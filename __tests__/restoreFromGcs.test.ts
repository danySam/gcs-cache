import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as core from "@actions/core";
import { Events, RefKey } from "../src/constants";
import { restoreImpl } from "../src/restoreImpl";
import { StateProvider } from "../src/stateProvider";
import * as testUtils from "../src/utils/testUtils";

jest.mock("@actions/cache/lib/internal/cacheUtils");
jest.mock("@actions/cache/lib/internal/tar");
jest.mock("@actions/cache");

var mockExists: jest.Mock;

jest.mock('@google-cloud/storage', () => {

    mockExists = jest.fn();

    const fakeFile = {
        exists: mockExists.mockResolvedValue([true]),
        download: jest.fn(),
    };

    const fakeBucket = {
        file: jest.fn().mockReturnValue(fakeFile),
    };

    const fakeStorage = {
        bucket: jest.fn().mockReturnValue(fakeBucket),
    };

    return {
        Storage: jest.fn().mockImplementation(() => fakeStorage),
    };
});

const infoMock = jest.spyOn(core, "info");
const failedMock = jest.spyOn(core, "setFailed");
const stateMock = jest.spyOn(core, "saveState");
const setCacheHitOutputMock = jest.spyOn(core, "setOutput");

jest.spyOn(cacheUtils, "createTempDirectory").mockResolvedValue("/tmp/cache-archive");
jest.spyOn(cacheUtils, "getCompressionMethod").mockResolvedValue(CompressionMethod.Gzip);
jest.spyOn(cacheUtils, "getCacheFileName").mockReturnValue("cache.tgz");
jest.spyOn(cacheUtils, "getArchiveFileSizeInBytes").mockReturnValue(100000);


const path = "node_modules";
const key = "node-test";

beforeEach(() => {
    process.env[Events.Key] = Events.Push;
    process.env[RefKey] = "refs/heads/feature-branch";
    testUtils.setInputs({
        path: path,
        key,
        enableCrossOsArchive: false,
        gcsBucket: "test-bucket",
    });
});

afterEach(() => {
    testUtils.clearInputs();
    delete process.env[Events.Key];
    delete process.env[RefKey];
});


test("restore with cache found for key", async () => {
    mockExists.mockResolvedValue([true]);

    await restoreImpl(new StateProvider());

    expect(stateMock).toHaveBeenCalledWith("CACHE_KEY", key);
    expect(setCacheHitOutputMock).toHaveBeenCalledTimes(1);
    expect(setCacheHitOutputMock).toHaveBeenCalledWith("cache-hit", "true");

    expect(infoMock).toHaveBeenCalledWith(`Cache restored from key: ${key}`);
    expect(failedMock).toHaveBeenCalledTimes(0);
});

test("restore with cache not found for key", async () => {

    mockExists.mockResolvedValue([false]);

    await restoreImpl(new StateProvider());

    expect(setCacheHitOutputMock).toHaveBeenCalledTimes(0);
    expect(stateMock).toHaveBeenCalledWith("CACHE_KEY", key);
    expect(infoMock).toHaveBeenCalledWith(`Cache not found for input keys: ${key}`);
    expect(failedMock).toHaveBeenCalledTimes(0);
});
