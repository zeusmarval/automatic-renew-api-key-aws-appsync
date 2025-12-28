# Automatically Renew AppSync API Key

This repository contains an AWS SAM template to set up a serverless application for automatically renewing AppSync API keys using AWS Lambda and other AWS services.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Usage](#usage)
  - [Schedule](#schedule)
  - [Lambda Function](#lambda-function)
  - [Environment Variables](#environment-variables)
  - [IAM Policies](#iam-policies)
- [Logging](#logging)
- [Clean Up](#clean-up)
- [Contributing](#contributing)
- [License](#license)
- [References](#references)

## Overview

The template provisions the following AWS resources:

- **AWS Lambda**: A function to renew AppSync API keys automatically.
- **AWS EventBridge**: Scheduled event that triggers the Lambda function periodically.
- **CloudWatch Logs**: Log group with 30-day retention for monitoring and debugging.

## Features

- **Automated API Key Renewal**: Periodically renews all AppSync API keys across all GraphQL APIs in your account.
- **Scheduled Execution**: Runs the renewal process every 300 days via EventBridge.
- **Intelligent Renewal**: Only renews keys that are expiring within a configurable threshold (default: 30 days).
- **Scalability**: Handles unlimited APIs and keys with automatic pagination.
- **Retry Logic**: Exponential backoff with jitter for handling transient errors.
- **Structured Logging**: JSON-formatted logs with optional sanitization of sensitive data.
- **Error Handling**: Comprehensive error handling with detailed reporting.

## Prerequisites

- An AWS account with appropriate permissions.
- AWS CLI configured with appropriate credentials.
- AWS SAM CLI installed for building and deploying.
- Node.js 22.x (for local development and testing).

## Deployment

1. **Clone the repository:**

    ```sh
    git clone https://github.com/zeusmarval/Automatic-Renew-API-KEY-AppSync
    cd automatic-renew-api-key-aws-appsync
    ```

2. **Build the SAM application:**

    ```sh
    sam build
    ```

    Or with Docker (recommended for consistent builds):

    ```sh
    sam build --use-container
    ```

3. **Deploy the stack:**

    ```sh
    sam deploy --guided
    ```

    Or deploy directly with a stack name:

    ```sh
    sam deploy --stack-name <environment>-<project>
    ```

    **Note**: The stack name should follow the format `<environment>-<project>` (e.g., `dev-common-services`, `prod-appsync-manager`).

## Configuration

The Lambda function can be configured through environment variables. All variables have default values and can be customized in the `template.yaml` file.

## Usage

### Schedule

The Lambda function is automatically triggered by an EventBridge rule that runs every 300 days. The schedule can be modified in the `template.yaml` file.

### Lambda Function

- **Handler**: `index.handler` located in `src/renew-appsync-api-key/index.mjs`
- **Runtime**: Node.js 22.x (LTS)
- **Timeout**: 30 seconds
- **Memory**: 128 MB

### Environment Variables

The following environment variables can be configured:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_RETRIES` | `3` | Maximum number of retry attempts for failed operations |
| `RETRY_DELAY_MS` | `1000` | Base delay in milliseconds for exponential backoff |
| `EXPIRATION_DAYS` | `365` | Number of days until API keys expire after renewal |
| `RENEWAL_THRESHOLD_DAYS` | `30` | Renew keys that expire within this many days |
| `PAGINATION_MAX_RESULTS` | `25` | Maximum results per page for API pagination |
| `FORCE_RENEWAL` | `"false"` | If `"true"`, renews all keys regardless of expiration |
| `ENABLE_SANITIZATION` | `"true"` | If `"true"`, sanitizes sensitive data in logs |

**Example**: To renew all keys regardless of expiration:

```yaml
FORCE_RENEWAL: "true"
```

**Example**: To disable log sanitization (see all data in logs):

```yaml
ENABLE_SANITIZATION: "false"
```

### IAM Policies

The Lambda function has the following permissions:

- **Actions**:
  - `appsync:ListGraphqlApis` - List all GraphQL APIs
  - `appsync:GetGraphqlApi` - Get API details
  - `appsync:ListApiKeys` - List API keys for each API
  - `appsync:UpdateApiKey` - Update API key expiration
- **Resource**: `*` (all AppSync resources in the account)


## Logging

The Lambda function uses structured JSON logging with the following features:

- **Structured Format**: All logs are in JSON format for easy parsing and analysis
- **Log Sanitization**: By default, sensitive data (API keys, tokens, secrets) is automatically redacted
- **Log Retention**: CloudWatch Logs are retained for 30 days
- **Log Levels**: INFO, WARN, and ERROR levels for different types of events

### Viewing Logs

View logs in CloudWatch:

```sh
aws logs tail /aws/lambda/<stack-name>-appsync-api-key --follow
```

Or in the AWS Console: CloudWatch → Log groups → `/aws/lambda/<stack-name>-appsync-api-key`

### Disabling Log Sanitization

To see all data in logs (including sensitive information), set:

```yaml
ENABLE_SANITIZATION: "false"
```

**Warning**: Only disable sanitization in development environments. Never disable in production.

## Clean Up

To delete the CloudFormation stack and all resources created:

```sh
sam delete --stack-name <environment>-<project>
```

Or using AWS CLI:

```sh
aws cloudformation delete-stack --stack-name <environment>-<project>
```

## How It Works

1. **Discovery**: The function lists all GraphQL APIs in your AWS account
2. **Evaluation**: For each API, it lists all API keys and evaluates which ones need renewal
3. **Renewal Criteria**: A key needs renewal if:
   - It has no expiration date
   - It's already expired
   - It expires within the `RENEWAL_THRESHOLD_DAYS` (default: 30 days)
   - `FORCE_RENEWAL` is enabled
4. **Update**: Only keys that need renewal are updated with a new expiration date
5. **Reporting**: Detailed statistics are logged and returned in the response

## Response Format

The Lambda function returns a JSON response with:

```json
{
  "statusCode": 200,
  "body": {
    "success": true,
    "message": "Processed 5/5 APIs. Evaluated 12 keys. Updated 3/3 keys...",
    "summary": {
      "totalApis": 5,
      "apisProcessed": 5,
      "totalKeys": 12,
      "keysEvaluated": 12,
      "keysNeedingRenewal": 3,
      "keysSkipped": 9,
      "keysUpdated": 3,
      "keysFailed": 0,
      "expirationDate": "2025-12-31T00:00:00.000Z",
      "expirationDays": 365,
      "renewalThresholdDays": 30
    },
    "durationMs": 2341
  }
}
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## References

- [AWS Serverless Application Model (SAM)](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
- [AWS AppSync API Keys](https://docs.aws.amazon.com/appsync/latest/devguide/security-authz.html#api-key-authorization)
- [EventBridge Schedules](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html)
- [CloudWatch Logs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/WhatIsCloudWatchLogs.html)
