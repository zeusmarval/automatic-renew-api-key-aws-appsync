import {
  AppSyncClient,
  ListGraphqlApisCommand,
  ListApiKeysCommand,
  UpdateApiKeyCommand,
} from "@aws-sdk/client-appsync";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

// Reusable AppSync client (global cache for warm starts)
let cachedAppSyncClient = null;
let cachedCloudWatchClient = null;

/**
 * Gets or creates the AppSync client (reusable across invocations)
 */
const getAppSyncClient = () => {
  if (!cachedAppSyncClient) {
    cachedAppSyncClient = new AppSyncClient({
      maxAttempts: 1, // We control retries manually
    });
  }
  return cachedAppSyncClient;
};

/**
 * Gets or creates the CloudWatch client (reusable across invocations)
 */
const getCloudWatchClient = () => {
  if (!cachedCloudWatchClient) {
    cachedCloudWatchClient = new CloudWatchClient({
      maxAttempts: 1,
    });
  }
  return cachedCloudWatchClient;
};

/**
 * Sanitizes data for logging (removes sensitive information)
 */
const sanitizeForLogging = (data) => {
  if (!data || typeof data !== "object") {
    return data;
  }

  const sensitiveKeys = ["apiKey", "key", "token", "secret", "password", "authorization"];
  const sanitized = { ...data };

  for (const key in sanitized) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof sanitized[key] === "object" && sanitized[key] !== null) {
      sanitized[key] = sanitizeForLogging(sanitized[key]);
    }
  }

  return sanitized;
};

// Structured logging configuration
const logger = {
  info: (message, data = {}) => {
    console.log(JSON.stringify({
      level: "INFO",
      message,
      ...sanitizeForLogging(data),
      timestamp: new Date().toISOString(),
    }));
  },
  error: (message, error = {}, data = {}) => {
    // Do not expose stack traces in production
    const errorInfo = {
      name: error.name,
      message: error.message,
      code: error.code,
      statusCode: error.$metadata?.httpStatusCode,
    };

    console.error(JSON.stringify({
      level: "ERROR",
      message,
      error: errorInfo,
      ...sanitizeForLogging(data),
      timestamp: new Date().toISOString(),
    }));
  },
  warn: (message, data = {}) => {
    console.warn(JSON.stringify({
      level: "WARN",
      message,
      ...sanitizeForLogging(data),
      timestamp: new Date().toISOString(),
    }));
  },
};

/**
 * Publishes custom metrics to CloudWatch
 */
const publishMetrics = async (namespace, metrics) => {
  try {
    const client = getCloudWatchClient();
    const timestamp = new Date();

    const metricData = Object.entries(metrics)
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([metricName, value]) => ({
        MetricName: metricName,
        Value: typeof value === "number" ? value : 1,
        Timestamp: timestamp,
        Unit: typeof value === "number" ? "Count" : "None",
      }));

    if (metricData.length === 0) {
      return;
    }

    const command = new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: metricData,
    });

    await client.send(command);
  } catch (error) {
    // Do not fail the function if metrics fail
    logger.warn("Failed to publish CloudWatch metrics", { error: error.message });
  }
};

/**
 * Gets configuration from environment variables with default values
 */
const getConfig = () => {
  const config = {
    // Retry configuration
    maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || "1000", 10),
    
    // Expiration configuration
    expirationDays: parseInt(process.env.EXPIRATION_DAYS || "365", 10),
    renewalThresholdDays: parseInt(process.env.RENEWAL_THRESHOLD_DAYS || "30", 10),
    
    // Pagination configuration
    paginationMaxResults: parseInt(process.env.PAGINATION_MAX_RESULTS || "25", 10),
    
    // Renewal configuration
    forceRenewal: process.env.FORCE_RENEWAL === "true",
    
    // Concurrency configuration
    maxConcurrentApis: parseInt(process.env.MAX_CONCURRENT_APIS || "10", 10),
    maxConcurrentKeys: parseInt(process.env.MAX_CONCURRENT_KEYS || "5", 10),
    
    // Metrics configuration
    metricsNamespace: process.env.METRICS_NAMESPACE || "AppSyncApiKeyRenewal",
    enableMetrics: process.env.ENABLE_METRICS !== "false",
  };

  // Validate minimum and maximum values
  config.maxRetries = Math.max(1, Math.min(10, config.maxRetries));
  config.retryDelayMs = Math.max(100, Math.min(10000, config.retryDelayMs));
  config.paginationMaxResults = Math.max(1, Math.min(100, config.paginationMaxResults));
  config.maxConcurrentApis = Math.max(1, Math.min(50, config.maxConcurrentApis));
  config.maxConcurrentKeys = Math.max(1, Math.min(20, config.maxConcurrentKeys));

  return config;
};

/**
 * Processes an array in batches with concurrency limit
 */
const processInBatches = async (items, batchSize, processor) => {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((item) => processor(item))
    );
    results.push(...batchResults);
  }
  return results;
};

/**
 * Determines if an error is retryable
 */
const isRetryableError = (error) => {
  // Server errors (5xx)
  const httpStatusCode = error.$metadata?.httpStatusCode;
  if (httpStatusCode >= 500 && httpStatusCode < 600) {
    return true;
  }

  // Throttling errors
  const retryableCodes = [
    "ThrottlingException",
    "Throttling",
    "TooManyRequestsException",
    "ServiceUnavailableException",
    "RequestTimeoutException",
  ];

  if (retryableCodes.includes(error.code)) {
    return true;
  }

  // Transient network errors
  if (error.name === "NetworkError" || error.name === "TimeoutError") {
    return true;
  }

  return false;
};

/**
 * Executes an operation with exponential retry and jitter
 */
const withRetry = async (operation, operationName, config) => {
  const maxRetries = config.maxRetries;
  const retryDelayMs = config.retryDelayMs;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = isRetryableError(error);

      if (!isRetryable || isLastAttempt) {
        throw error;
      }

      // Exponential backoff with jitter to avoid thundering herd
      const baseDelay = retryDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 0.3 * baseDelay; // 0-30% jitter
      const delay = Math.floor(baseDelay + jitter);

      logger.warn(`${operationName} failed, retrying...`, {
        attempt,
        maxRetries,
        delayMs: delay,
        errorCode: error.code,
        httpStatusCode: error.$metadata?.httpStatusCode,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

/**
 * Calculates the expiration date based on configuration
 */
const calculateExpirationDate = (expirationDays) => {
  if (expirationDays <= 0 || expirationDays > 3650) {
    throw new Error(`Invalid expirationDays: ${expirationDays}. Must be between 1 and 3650`);
  }

  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + expirationDays);
  expirationDate.setHours(0, 0, 0, 0);
  const expires = Math.floor(expirationDate.getTime() / 1000);

  // Validation: ensure the date is valid and in the future
  if (isNaN(expires) || expires <= Math.floor(Date.now() / 1000)) {
    throw new Error("Invalid expiration date calculated");
  }

  return { expires, expirationDate: expirationDate.toISOString() };
};

/**
 * Determines if an API key needs renewal
 * @param {Object} apiKey - API key object with expires property
 * @param {number} renewalThresholdDays - Days before expiration to consider renewal
 * @param {boolean} forceRenewal - If true, renews all keys regardless of expiration
 * @returns {Object} - { needsRenewal: boolean, daysUntilExpiration: number, reason: string }
 */
const shouldRenewApiKey = (apiKey, renewalThresholdDays, forceRenewal) => {
  // If forceRenewal is enabled, renew all
  if (forceRenewal) {
    return {
      needsRenewal: true,
      daysUntilExpiration: apiKey.expires ? Math.floor((apiKey.expires - Date.now() / 1000) / 86400) : null,
      reason: "FORCE_RENEWAL_ENABLED",
    };
  }

  // If it has no expiration date, renew
  if (!apiKey.expires) {
    return {
      needsRenewal: true,
      daysUntilExpiration: null,
      reason: "NO_EXPIRATION_DATE",
    };
  }

  // Calculate days until expiration
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const daysUntilExpiration = Math.floor((apiKey.expires - currentTimestamp) / 86400);

  // If already expired, renew
  if (daysUntilExpiration <= 0) {
    return {
      needsRenewal: true,
      daysUntilExpiration,
      reason: "ALREADY_EXPIRED",
    };
  }

  // If within threshold, renew
  if (daysUntilExpiration <= renewalThresholdDays) {
    return {
      needsRenewal: true,
      daysUntilExpiration,
      reason: "WITHIN_RENEWAL_THRESHOLD",
    };
  }

  // Does not need renewal
  return {
    needsRenewal: false,
    daysUntilExpiration,
    reason: "NOT_WITHIN_THRESHOLD",
  };
};

/**
 * Lists all GraphQL APIs with pagination
 */
const listAllGraphqlApis = async (client, config) => {
  const allApis = [];
  let nextToken = null;
  let pageCount = 0;
  const maxPages = 1000; // Safety limit

  do {
    try {
      const command = new ListGraphqlApisCommand({
        maxResults: config.paginationMaxResults,
        nextToken,
      });

      const response = await withRetry(
        () => client.send(command),
        "ListGraphqlApis",
        config
      );

      // Validate response
      if (!response || typeof response !== "object") {
        throw new Error("Invalid response from ListGraphqlApis");
      }

      if (response.graphqlApis && Array.isArray(response.graphqlApis) && response.graphqlApis.length > 0) {
        allApis.push(...response.graphqlApis);
      }

      nextToken = response.nextToken;
      pageCount++;

      // Protection against infinite loops
      if (pageCount >= maxPages) {
        logger.warn("Reached maximum page limit for ListGraphqlApis", { maxPages });
        break;
      }
    } catch (error) {
      logger.error("Error listing GraphQL APIs", error);
      throw error;
    }
  } while (nextToken);

  logger.info("Listed all GraphQL APIs", { totalApis: allApis.length, pages: pageCount });
  return allApis;
};

/**
 * Lists all API keys for an API with pagination
 */
const listAllApiKeys = async (client, apiId, config) => {
  const allKeys = [];
  let nextToken = null;
  let pageCount = 0;
  const maxPages = 1000; // Safety limit

  // Validate apiId
  if (!apiId || typeof apiId !== "string" || apiId.trim().length === 0) {
    logger.warn("Invalid apiId provided to listAllApiKeys", { apiId });
    return [];
  }

  do {
    try {
      const command = new ListApiKeysCommand({
        apiId,
        maxResults: config.paginationMaxResults,
        nextToken,
      });

      const response = await withRetry(
        () => client.send(command),
        `ListApiKeys-${apiId}`,
        config
      );

      // Validate response
      if (!response || typeof response !== "object") {
        logger.warn("Invalid response from ListApiKeys", { apiId });
        break;
      }

      if (response.apiKeys && Array.isArray(response.apiKeys) && response.apiKeys.length > 0) {
        allKeys.push(...response.apiKeys);
      }

      nextToken = response.nextToken;
      pageCount++;

      // Protection against infinite loops
      if (pageCount >= maxPages) {
        logger.warn("Reached maximum page limit for ListApiKeys", { apiId, maxPages });
        break;
      }
    } catch (error) {
      // Permission errors or API not found are not retryable
      if (error.code === "NotFoundException" || error.code === "UnauthorizedException") {
        logger.warn("API not found or unauthorized", { apiId, errorCode: error.code });
        return [];
      }
      logger.error("Error listing API keys", error, { apiId });
      // We don't throw the error here to continue with other APIs
      return [];
    }
  } while (nextToken);

  return allKeys;
};

/**
 * Updates an individual API key
 */
const updateApiKey = async (client, apiId, keyId, expires, config) => {
  // Validate parameters
  if (!apiId || typeof apiId !== "string" || apiId.trim().length === 0) {
    return { success: false, keyId, apiId, error: "Invalid apiId" };
  }

  if (!keyId || typeof keyId !== "string" || keyId.trim().length === 0) {
    return { success: false, keyId, apiId, error: "Invalid keyId" };
  }

  if (!expires || typeof expires !== "number" || expires <= 0) {
    return { success: false, keyId, apiId, error: "Invalid expires timestamp" };
  }

  try {
    const command = new UpdateApiKeyCommand({
      apiId,
      id: keyId,
      expires,
    });

    const result = await withRetry(
      () => client.send(command),
      `UpdateApiKey-${apiId}-${keyId}`,
      config
    );

    // Validate response
    if (!result || typeof result !== "object") {
      throw new Error("Invalid response from UpdateApiKey");
    }

    if (!result.apiKey) {
      throw new Error("UpdateApiKey returned no apiKey in response");
    }

    // Validate that the expiration date was updated correctly
    if (result.apiKey.expires && result.apiKey.expires !== expires) {
      logger.warn("Expiration date mismatch after update", {
        apiId,
        keyId,
        expected: expires,
        actual: result.apiKey.expires,
      });
    }

    return { success: true, keyId, apiId, expires: result.apiKey.expires };
  } catch (error) {
    // Specific errors that should not be retryable
    const nonRetryableErrors = [
      "NotFoundException",
      "UnauthorizedException",
      "BadRequestException",
      "ValidationException",
    ];

    const errorCode = error.code || error.name;
    const isNonRetryable = nonRetryableErrors.includes(errorCode);

    logger.error("Error updating API key", error, {
      apiId,
      keyId,
      errorCode,
      isNonRetryable,
    });

    return {
      success: false,
      keyId,
      apiId,
      error: error.message,
      errorCode,
    };
  }
};

/**
 * Processes all APIs and their keys
 */
const processAllApis = async (client, expires, config) => {
  const results = {
    totalApis: 0,
    apisProcessed: 0,
    totalKeys: 0,
    keysEvaluated: 0,
    keysNeedingRenewal: 0,
    keysSkipped: 0,
    keysUpdated: 0,
    keysFailed: 0,
    errors: [],
  };

  try {
    const graphqlApis = await listAllGraphqlApis(client, config);
    results.totalApis = graphqlApis.length;

    if (graphqlApis.length === 0) {
      logger.info("No GraphQL APIs found");
      return results;
    }

    logger.info("Starting API key renewal process", {
      totalApis: graphqlApis.length,
      expirationDate: expires.expirationDate,
      renewalThresholdDays: config.renewalThresholdDays,
      forceRenewal: config.forceRenewal,
    });

    // Process each API in parallel and collect individual results
    const apiResults = await Promise.allSettled(
      graphqlApis.map(async (api) => {
        const apiId = api.apiId;
        const apiName = api.name;

        // Local results for this API to avoid race conditions
        const apiResult = {
          totalKeys: 0,
          keysEvaluated: 0,
          keysNeedingRenewal: 0,
          keysSkipped: 0,
          keysUpdated: 0,
          keysFailed: 0,
          errors: [],
          processed: false,
        };

        try {
          const apiKeys = await listAllApiKeys(client, apiId, config);

          if (apiKeys.length === 0) {
            logger.info("No API keys found for API", { apiId, apiName });
            apiResult.processed = true;
            return apiResult;
          }

          apiResult.totalKeys = apiKeys.length;
          logger.info("Processing API keys", {
            apiId,
            apiName,
            keyCount: apiKeys.length,
          });

          // Filter keys that need renewal
          const keysToRenew = [];
          const renewalDecisions = [];

          apiKeys.forEach((key) => {
            apiResult.keysEvaluated++;
            const decision = shouldRenewApiKey(
              key,
              config.renewalThresholdDays,
              config.forceRenewal
            );

            renewalDecisions.push({
              keyId: key.id,
              decision,
            });

            if (decision.needsRenewal) {
              apiResult.keysNeedingRenewal++;
              keysToRenew.push(key);
              logger.info("API key needs renewal", {
                apiId,
                apiName,
                keyId: key.id,
                reason: decision.reason,
                daysUntilExpiration: decision.daysUntilExpiration,
              });
            } else {
              apiResult.keysSkipped++;
              logger.info("API key skipped (no renewal needed)", {
                apiId,
                apiName,
                keyId: key.id,
                reason: decision.reason,
                daysUntilExpiration: decision.daysUntilExpiration,
              });
            }
          });

          // Update only the keys that need renewal
          if (keysToRenew.length === 0) {
            logger.info("No API keys need renewal for this API", {
              apiId,
              apiName,
            });
            apiResult.processed = true;
            return apiResult;
          }

          const updateResults = await Promise.allSettled(
            keysToRenew.map((key) =>
              updateApiKey(client, apiId, key.id, expires.expires, config)
            )
          );

          // Process results
          updateResults.forEach((result, index) => {
            if (result.status === "fulfilled") {
              if (result.value.success) {
                apiResult.keysUpdated++;
                logger.info("API key updated successfully", {
                  apiId,
                  apiName,
                  keyId: result.value.keyId,
                });
              } else {
                apiResult.keysFailed++;
                apiResult.errors.push({
                  apiId,
                  apiName,
                  keyId: result.value.keyId,
                  error: result.value.error,
                });
              }
            } else {
              apiResult.keysFailed++;
              apiResult.errors.push({
                apiId,
                apiName,
                keyId: keysToRenew[index]?.id,
                error: result.reason?.message || "Unknown error",
              });
            }
          });

          apiResult.processed = true;
          return apiResult;
        } catch (error) {
          logger.error("Error processing API", error, { apiId, apiName });
          apiResult.errors.push({
            apiId,
            apiName,
            error: error.message,
          });
          return apiResult;
        }
      })
    );

    // Consolidate results safely (no race conditions)
    apiResults.forEach((apiResult) => {
      if (apiResult.status === "fulfilled" && apiResult.value) {
        const apiData = apiResult.value;
        results.totalKeys += apiData.totalKeys;
        results.keysEvaluated += apiData.keysEvaluated;
        results.keysNeedingRenewal += apiData.keysNeedingRenewal;
        results.keysSkipped += apiData.keysSkipped;
        results.keysUpdated += apiData.keysUpdated;
        results.keysFailed += apiData.keysFailed;
        results.errors.push(...apiData.errors);
        if (apiData.processed) {
          results.apisProcessed++;
        }
      } else if (apiResult.status === "rejected") {
        results.errors.push({
          error: apiResult.reason?.message || "Unknown error processing API",
        });
      }
    });

    return results;
  } catch (error) {
    logger.error("Fatal error in processAllApis", error);
    throw error;
  }
};

/**
 * Main Lambda handler
 */
export const handler = async (event) => {
  const startTime = Date.now();
  const config = getConfig();
  
  logger.info("Lambda function started", {
    event,
    config: {
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
      expirationDays: config.expirationDays,
      renewalThresholdDays: config.renewalThresholdDays,
      paginationMaxResults: config.paginationMaxResults,
      forceRenewal: config.forceRenewal,
    },
  });

  try {
    // Validate configuration
    if (config.expirationDays <= 0 || config.expirationDays > 3650) {
      throw new Error(`Invalid EXPIRATION_DAYS: ${config.expirationDays}. Must be between 1 and 3650`);
    }

    if (config.renewalThresholdDays < 0 || config.renewalThresholdDays > 365) {
      throw new Error(`Invalid RENEWAL_THRESHOLD_DAYS: ${config.renewalThresholdDays}. Must be between 0 and 365`);
    }

    // Initialize AppSync client
    const client = getAppSyncClient();

    // Calculate expiration date
    const expires = calculateExpirationDate(config.expirationDays);
    logger.info("Expiration date calculated", {
      expires: expires.expires,
      expirationDate: expires.expirationDate,
      expirationDays: config.expirationDays,
    });

    // Process all APIs
    const results = await processAllApis(client, expires, config);

    const duration = Date.now() - startTime;
    const response = {
      statusCode: results.keysFailed > 0 ? 207 : 200, // 207 Multi-Status if there are partial errors
      body: JSON.stringify({
        success: results.keysFailed === 0,
        message: `Processed ${results.apisProcessed}/${results.totalApis} APIs. Evaluated ${results.keysEvaluated} keys. Updated ${results.keysUpdated}/${results.keysNeedingRenewal} keys that needed renewal. Skipped ${results.keysSkipped} keys.`,
        summary: {
          totalApis: results.totalApis,
          apisProcessed: results.apisProcessed,
          totalKeys: results.totalKeys,
          keysEvaluated: results.keysEvaluated,
          keysNeedingRenewal: results.keysNeedingRenewal,
          keysSkipped: results.keysSkipped,
          keysUpdated: results.keysUpdated,
          keysFailed: results.keysFailed,
          expirationDate: expires.expirationDate,
          expirationDays: config.expirationDays,
          renewalThresholdDays: config.renewalThresholdDays,
          forceRenewal: config.forceRenewal,
        },
        errors: results.errors.length > 0 ? results.errors : undefined,
        durationMs: duration,
      }),
    };

    logger.info("Lambda function completed", {
      statusCode: response.statusCode,
      durationMs: duration,
      summary: results,
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("Lambda function failed", error, { durationMs: duration });

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Error processing API key renewal",
        error: error.message,
        errorCode: error.code,
        durationMs: duration,
      }),
    };
  }
};
