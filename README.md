# Automatically Renew AppSync API Key

This repository contains an AWS CloudFormation template to set up a serverless application for automatically renewing AppSync API keys using AWS Lambda and other AWS services.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Deployment](#deployment)
- [Usage](#usage)
  - [Schedule](#schedule)
  - [Lambda Function](#lambda-function)
  - [IAM Policies](#iam-policies)
- [Clean Up](#clean-up)
- [References](#references)

## Overview

The template provisions the following AWS resources:

- **AWS Lambda**: A function to renew AppSync API keys.
- **AWS Eventbridge Events**: Triggers the Lambda function periodically.

## Features

- **Automated API Key Renewal**: Periodically renews all AppSync API keys.
- **Scheduled Execution**: Runs the renewal process every 300 days.
- **Scalability**: Designed to handle up to 25 AppSync API keys.

## Prerequisites

- An AWS account.
- AWS CLI configured with appropriate permissions.
- Node.js installed for Lambda function development.

## Deployment

1. **Clone the repository:**

    ```sh
    git clone https://github.com/zeusmarval/Automatic-Renew-API-KEY-AppSync
    cd renew-appsync-api-key
    ```

2. **Package the stack:**

    ```sh
    sam build --use-container
    ```

3. **Deploy the CloudFormation stack:**

    ```sh
    aws cloudformation deploy \
        --template-file template.yaml \
        --stack-name RenewAppSyncApiKey \
        --capabilities CAPABILITY_NAMED_IAM
    ```

## Usage

### Schedule

The Lambda function is triggered by a Events rule that runs every 300 days.

### Lambda Function

- **Handler**: The entry point for the Lambda function is defined in the `index.handler` file located in the `handlers` directory.
- **Runtime**: Node.js 20.x is used as the runtime environment.

### IAM Policies

The Lambda function has the following permissions:

- **Actions**:
  - `appsync:ListGraphqlApis`
  - `appsync:GetGraphqlApi`
  - `appsync:ListApiKeys`
  - `appsync:UpdateApiKey`
- **Resource**: `*`


## Clean Up

To delete the CloudFormation stack and all resources created:

```sh
aws cloudformation delete-stack --stack-name RenewAppSyncApiKey
```

## References

- Building lambdas with infrastructure as code: [Serverless Application Model (SAM) - Lambda](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-getting-started-hello-world.html)
- Create scheduled events: [Schedule - AWS Serverless Application Model](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-schedule.html)
- Role policies: [AWS SAM policy templates - AWS Serverless Application Model](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-policy-templates.html)
