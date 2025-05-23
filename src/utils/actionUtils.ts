import * as cache from "@actions/cache";
import * as core from "@actions/core";

import { Inputs, RefKey } from "../constants";

export function isGhes(): boolean {
    const ghUrl = new URL(
        process.env["GITHUB_SERVER_URL"] || "https://github.com"
    );

    const hostname = ghUrl.hostname.trimEnd().toUpperCase();
    const isGitHubHost = hostname === "GITHUB.COM";
    const isGitHubEnterpriseCloudHost = hostname.endsWith(".GHE.COM");
    const isLocalHost = hostname.endsWith(".LOCALHOST");

    return !isGitHubHost && !isGitHubEnterpriseCloudHost && !isLocalHost;
}

export function isExactKeyMatch(key: string, cacheKey?: string): boolean {
    return !!(
        cacheKey &&
        cacheKey.localeCompare(key, undefined, {
            sensitivity: "accent"
        }) === 0
    );
}

export function logWarning(message: string): void {
    const warningPrefix = "[warning]";
    core.info(`${warningPrefix}${message}`);
}

// Cache token authorized for all events that are tied to a ref
// See GitHub Context https://help.github.com/actions/automating-your-workflow-with-github-actions/contexts-and-expression-syntax-for-github-actions#github-context
export function isValidEvent(): boolean {
    return RefKey in process.env && Boolean(process.env[RefKey]);
}

export function getInputAsArray(
    name: string,
    options?: core.InputOptions
): string[] {
    return core
        .getInput(name, options)
        .split("\n")
        .map(s => s.replace(/^!\s+/, "!").trim())
        .filter(x => x !== "");
}

export function getInputAsInt(
    name: string,
    options?: core.InputOptions
): number | undefined {
    const value = parseInt(core.getInput(name, options));
    if (isNaN(value) || value < 0) {
        return undefined;
    }
    return value;
}

export function getInputAsBool(
    name: string,
    options?: core.InputOptions
): boolean {
    const result = core.getInput(name, options);
    return result.toLowerCase() === "true";
}

// Check if GCS is configured and available
export function isGCSAvailable(): boolean {
    try {
        const bucket = core.getInput(Inputs.GCSBucket);
        if (!bucket) {
            core.info(
                "GCS bucket name not provided, falling back to GitHub cache"
            );
            return false;
        }

        // We're not doing an actual authentication check here as it would require
        // making an API call. The Storage client will handle authentication later
        // via Application Default Credentials (ADC) which supports multiple auth methods:
        // - Service account JSON key file (GOOGLE_APPLICATION_CREDENTIALS)
        // - Workload Identity Federation
        // - Metadata server-based auth (GCE, GKE)
        // - User credentials from gcloud CLI

        core.info(`GCS bucket configured: ${bucket}`);
        return true;
    } catch (error) {
        logWarning(
            `Failed to check GCS availability: ${(error as Error).message}`
        );
        return false;
    }
}

export function isCacheFeatureAvailable(): boolean {
    // Check if GCS cache is available
    if (isGCSAvailable()) {
        return true;
    }

    // Otherwise, check GitHub cache
    if (cache.isFeatureAvailable()) {
        return true;
    }

    if (isGhes()) {
        logWarning(
            `Cache action is only supported on GHES version >= 3.5. If you are on version >=3.5 Please check with GHES admin if Actions cache service is enabled or not.
Otherwise please upgrade to GHES version >= 3.5 and If you are also using Github Connect, please unretire the actions/cache namespace before upgrade (see https://docs.github.com/en/enterprise-server@3.5/admin/github-actions/managing-access-to-actions-from-githubcom/enabling-automatic-access-to-githubcom-actions-using-github-connect#automatic-retirement-of-namespaces-for-actions-accessed-on-githubcom)`
        );
        return false;
    }

    logWarning(
        "An internal error has occurred in cache backend. Please check https://www.githubstatus.com/ for any ongoing issue in actions."
    );
    return false;
}
