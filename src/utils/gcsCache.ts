import * as core from "@actions/core";
import * as path from "path";
import { Inputs } from "../constants";
import { isGCSAvailable } from "./actionUtils";
import * as utils from "@actions/cache/lib/internal/cacheUtils"
import { Storage } from "@google-cloud/storage";
import * as cache from "@actions/cache";
import { DownloadOptions, UploadOptions } from '@actions/cache/lib/options'
import { createTar, extractTar, listTar } from "@actions/cache/lib/internal/tar"
import { CompressionMethod } from "@actions/cache/lib/internal/constants";

const DEFAULT_PATH_PREFIX = "github-cache"

// Function to initialize GCS client using Application Default Credentials
function getGCSClient(): Storage | null {
    try {
        core.info("Initializing GCS client");
        // Log the authentication environment
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            core.info(`Using authentication from GOOGLE_APPLICATION_CREDENTIALS`);
        } else {
            core.info(`GOOGLE_APPLICATION_CREDENTIALS not found, using Application Default Credentials`);
        }
        
        return new Storage();
    } catch (error) {
        core.warning(`Failed to initialize GCS client: ${(error as Error).message}`);
        return null;
    }
}

export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    options?: DownloadOptions,
    enableCrossOsArchive?: boolean
): Promise<string | undefined> {
    // Check if GCS is available
    if (isGCSAvailable()) {
        try {
            const result = await restoreFromGCS(
                paths,
                primaryKey,
                restoreKeys,
                options
            );

            if (result) {
                core.info(`Cache restored from GCS with key: ${result}`);
                return result;
            }

            core.info("Cache not found in GCS, falling back to GitHub cache");
        } catch (error) {
            core.warning(`Failed to restore from GCS: ${(error as Error).message}`);
            core.info("Falling back to GitHub cache");
        }
    }

    // Fall back to GitHub cache
    return await cache.restoreCache(
        paths,
        primaryKey,
        restoreKeys,
        options,
        enableCrossOsArchive
    );
}

export async function saveCache(
    paths: string[],
    key: string,
    options?: UploadOptions,
    enableCrossOsArchive?: boolean
): Promise<number> {
    if (isGCSAvailable()) {
        try {
            const result = await saveToGCS(paths, key);
            if (result) {
                core.info(`Cache saved to GCS with key: ${key}`);
                return result; // Success ID
            }

            core.warning("Failed to save to GCS, falling back to GitHub cache");
        } catch (error) {
            core.warning(`Failed to save to GCS: ${(error as Error).message}`);
            core.info("Falling back to GitHub cache");
        }
    }

    // Fall back to GitHub cache
    return await cache.saveCache(
        paths,
        key,
        options,
        enableCrossOsArchive
    );
}

// Function that checks if the cache feature is available (either GCS or GitHub cache)
export function isFeatureAvailable(): boolean {
    return isGCSAvailable() || cache.isFeatureAvailable();
}

async function restoreFromGCS(
    paths: string[], 
    primaryKey: string,
    restoreKeys: string[] = [],
    options?: DownloadOptions 
): Promise<string | undefined> {
    const storage = getGCSClient();
    if (!storage) {
        core.warning("Failed to initialize GCS client, cannot restore cache");
        return undefined;
    }

    const bucket = core.getInput(Inputs.GCSBucket);
    const pathPrefix = core.getInput(Inputs.GCSPathPrefix) || DEFAULT_PATH_PREFIX;
    const compressionMethod = await utils.getCompressionMethod()

    core.info(`GCS Bucket: ${bucket}`);
    core.info(`GCS Path Prefix: ${pathPrefix}`);
    core.info(`Primary Key: ${primaryKey}`);
    if (restoreKeys.length > 0) {
        core.info(`Restore Keys: ${restoreKeys.join(', ')}`);
    }
    
    // Verify bucket exists
    try {
        const [exists] = await storage.bucket(bucket).exists();
        if (!exists) {
            core.warning(`Bucket ${bucket} does not exist or is not accessible`);
            return undefined;
        }
        core.info(`Successfully connected to bucket: ${bucket}`);
    } catch (error) {
        core.warning(`Error checking bucket existence: ${(error as Error).message}`);
        return undefined;
    }

    // Verify the paths exist for extraction
    for (const cachePath of paths) {
        // Create the directory if it doesn't exist
        const dirPath = path.dirname(cachePath);
        try {
            await require('fs').promises.mkdir(dirPath, { recursive: true });
            core.debug(`Created directory: ${dirPath}`);
        } catch (error) {
            core.warning(`Failed to create directory ${dirPath}: ${(error as Error).message}`);
        }
    }

    const archiveFolder = await utils.createTempDirectory()
    const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod)
    )

    core.info(`Archive Path: ${archivePath}`);

    const keys = [primaryKey, ...restoreKeys]
    core.info(`Looking for cache with keys: ${keys.join(', ')}`);
    const gcsPath = await findFileOnGCS(storage, bucket, pathPrefix, keys, compressionMethod)

    if (!gcsPath) {
        core.info(`No matching cache found in GCS`)
        return undefined;
    }

    // If lookup only, just return the key
    if (options?.lookupOnly) {
        core.info(`Cache found in GCS with key: ${gcsPath}`);
        return gcsPath;
    }

    try {
        core.info(`Downloading from GCS: ${bucket}/${gcsPath}`);
        const file = storage.bucket(bucket).file(gcsPath);
        await file.download({ destination: archivePath });

        // Verify the downloaded file
        try {
            const stats = require('fs').statSync(archivePath);
            core.info(`Downloaded archive size: ${stats.size} bytes`);
            if (stats.size === 0) {
                core.warning("Downloaded archive file is empty");
                return undefined;
            }
        } catch (error) {
            core.warning(`Error checking downloaded archive: ${(error as Error).message}`);
            return undefined;
        }

        // Always list contents in the logs for debugging
        core.info("Listing archive contents:");
        await listTar(archivePath, compressionMethod)

        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath)
        core.info(
            `Cache Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        )

        core.info(`Extracting archive to restore cache files`);
        await extractTar(archivePath, compressionMethod)
        
        // Verify extraction succeeded
        let extractionSucceeded = false;
        for (const cachePath of paths) {
            try {
                const exists = require('fs').existsSync(cachePath);
                if (exists) {
                    core.info(`Verified cache path exists after extraction: ${cachePath}`);
                    extractionSucceeded = true;
                    break;
                }
            } catch (error) {
                core.warning(`Error checking path ${cachePath}: ${(error as Error).message}`);
            }
        }
        
        if (extractionSucceeded) {
            core.info('Cache restored successfully from GCS');
            return gcsPath;
        } else {
            core.warning('Extraction completed but cache files not found');
            return undefined;
        }
    } catch (error) {
        core.warning(`Failed to restore from GCS: ${(error as Error).message}`);
        if (error instanceof Error && error.stack) {
            core.debug(`Stack trace: ${error.stack}`);
        }
        return undefined;
    } finally {
        try {
            await utils.unlinkFile(archivePath);
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }
}

function getGCSPath(pathPrefix: any, key: any, compressionMethod: CompressionMethod) {
    return `${pathPrefix}/${key}.${utils.getCacheFileName(compressionMethod)}`;
}


async function saveToGCS(
    paths: string[],
    key: string
): Promise<number> {
    let cacheId = -1
    const storage = getGCSClient();
    if (!storage) {
        core.warning("Failed to initialize GCS client, cannot save cache");
        return cacheId;
    }

    const bucket = core.getInput(Inputs.GCSBucket);
    const pathPrefix = core.getInput(Inputs.GCSPathPrefix) || DEFAULT_PATH_PREFIX;
    const compressionMethod = await utils.getCompressionMethod()

    core.info(`GCS Bucket: ${bucket}`);
    core.info(`GCS Path Prefix: ${pathPrefix}`);
    
    // Verify bucket exists
    try {
        const [exists] = await storage.bucket(bucket).exists();
        if (!exists) {
            core.warning(`Bucket ${bucket} does not exist or is not accessible`);
            return -1;
        }
        core.info(`Successfully connected to bucket: ${bucket}`);
    } catch (error) {
        core.warning(`Error checking bucket existence: ${(error as Error).message}`);
        return -1;
    }

    const cachePaths = await utils.resolvePaths(paths)
    core.info('Cache Paths:')
    core.info(`${JSON.stringify(cachePaths)}`)

    if (cachePaths.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
        )
    }

    const archiveFolder = await utils.createTempDirectory()
    const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod)
    )

    core.info(`Archive Path: ${archivePath}`)

    try {
        core.info("Creating tar archive of cache files");
        await createTar(archiveFolder, cachePaths, compressionMethod)
        
        // Always show the tar contents in logs for debugging
        core.info("Listing tar archive contents:");
        await listTar(archivePath, compressionMethod)
        
        // Check if the archive was created and has content
        try {
            const stats = require('fs').statSync(archivePath);
            core.info(`Archive size: ${stats.size} bytes`);
            if (stats.size === 0) {
                core.warning("Archive file is empty, no data to upload");
                return -1;
            }
        } catch (error) {
            core.warning(`Error checking archive file: ${(error as Error).message}`);
            return -1;
        }

        const gcsPath = getGCSPath(pathPrefix, key, compressionMethod)
        core.info(`Uploading to GCS: ${bucket}/${gcsPath}`);
        
        await storage.bucket(bucket).upload(archivePath, {
            destination: gcsPath,
            resumable: true,
            gzip: false, // Disable auto compression since we're already using compression
            // Add metadata for easier identification
            metadata: {
                metadata: {
                    cacheKey: key,
                    createdBy: 'gcs-cache-action',
                    createdAt: new Date().toISOString()
                }
            }
        });
        
        core.info("Upload complete, verifying file exists in GCS");
        const [exists] = await storage.bucket(bucket).file(gcsPath).exists();
        if (exists) {
            core.info(`Successfully verified cache file exists in GCS: ${bucket}/${gcsPath}`);
            return 1;
        } else {
            core.warning(`Upload appeared to succeed but file not found in GCS`);
            return -1;
        }
    } catch (error) {
        core.warning(`Error creating or uploading cache: ${(error as Error).message}`);
        if (error instanceof Error && error.stack) {
            core.debug(`Stack trace: ${error.stack}`);
        }
        return -1;
    } finally {
        try {
            await utils.unlinkFile(archivePath)
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`)
        }
    }
}

async function findFileOnGCS(
    storage: Storage,
    bucket: string,
    pathPrefix: string,
    keys: string[],
    compressionMethod: CompressionMethod,
): Promise<string | undefined> {
    for (const key of keys) {
        const gcsPath = getGCSPath(pathPrefix, key, compressionMethod)
        core.info(`Checking if cache exists at: ${bucket}/${gcsPath}`);
        
        try {
            if (await checkFileExists(storage, bucket, gcsPath)) {
                core.info(`Found cache file in bucket: ${bucket} with path: ${gcsPath}`)
                return gcsPath
            } else {
                core.info(`No cache file found at: ${bucket}/${gcsPath}`);
            }
        } catch (error) {
            core.warning(`Error checking if file exists at ${bucket}/${gcsPath}: ${(error as Error).message}`);
        }
    }
    
    // If no exact matches, try listing the directory to see what's available
    try {
        core.info(`Listing files in prefix: ${pathPrefix}`);
        const [files] = await storage.bucket(bucket).getFiles({ prefix: pathPrefix });
        
        if (files.length > 0) {
            core.info(`Found ${files.length} files in ${pathPrefix}:`);
            for (const file of files) {
                core.info(`- ${file.name}`);
            }
        } else {
            core.info(`No files found in prefix: ${pathPrefix}`);
        }
    } catch (error) {
        core.warning(`Error listing files in prefix ${pathPrefix}: ${(error as Error).message}`);
    }
    
    return undefined
}

async function checkFileExists(storage: Storage, bucket: string, path: string): Promise<boolean> {
    try {
        const [exists] = await storage.bucket(bucket).file(path).exists();
        return exists;
    } catch (error) {
        core.warning(`Error checking file existence: ${(error as Error).message}`);
        throw error;
    }
}
