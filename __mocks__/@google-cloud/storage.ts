const mockDownload = jest.fn().mockResolvedValue(undefined);
const mockExists = jest.fn().mockResolvedValue([false]);
const mockUpload = jest
    .fn()
    .mockResolvedValue([{ metadata: { id: "mock-id" } }]);
const mockGetFiles = jest.fn().mockResolvedValue([[]]);

const mockFile = jest.fn().mockReturnValue({
    exists: mockExists,
    download: mockDownload
});

const mockBucket = jest.fn().mockReturnValue({
    file: mockFile,
    upload: mockUpload,
    getFiles: mockGetFiles
});

const Storage = jest.fn().mockImplementation(() => ({
    bucket: mockBucket
}));

export {
    Storage,
    mockBucket,
    mockFile,
    mockExists,
    mockDownload,
    mockUpload,
    mockGetFiles
};
