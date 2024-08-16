import AWS from "aws-sdk";

export const handler = async (event) => {
  let keyCount = 0;
  let errorUpdate = 0;
  const appsync = new AWS.AppSync({ apiVersion: "2017-07-25" });

  // Calculate expiration date once
  const dateExpiration = new Date();
  dateExpiration.setDate(d.getDate() + 365);
  dateExpiration.setHours(0, 0, 0);
  dateExpiration.setMilliseconds(0);
  const expires = Math.floor(dateExpiration / 1000);

  try {
    const { graphqlApis } = await appsync.listGraphqlApis({ maxResults: 25 }).promise();

    if (!graphqlApis || graphqlApis.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify("No APIs found!"),
      };
    }

    // Use Promise.all to handle asynchronous operations in parallel
    await Promise.all(graphqlApis.map(async (api) => {
      const apiId = api.apiId;
      const { apiKeys } = await appsync.listApiKeys({ apiId }).promise();

      if (!apiKeys || apiKeys.length === 0) {
        return;
      }

      await Promise.all(apiKeys.map(async (key) => {
        try {
          const params = { apiId, id: key.id, expires };
          const result = await appsync.updateApiKey(params).promise();
          if (result.apiKey) {
            keyCount++;
          } else {
            errorUpdate++;
          }
        } catch (error) {
          errorUpdate++;
        }
      }));
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(`${keyCount} key${keyCount !== 1 ? "s" : ""} updated.`),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify(`Error updating keys: ${error.message}`),
    };
  }
};
