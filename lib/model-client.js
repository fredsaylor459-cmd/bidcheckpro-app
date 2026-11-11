'use strict';

let testClient = null;

function setModelClientForTests(client) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Model test client refused outside NODE_ENV=test');
  }
  testClient = client;
}

async function defaultModelClient({ bidText, side, thorough }) {
  const apiKey = process.env.AI_API_KEY;
  const apiUrl = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: thorough
            ? 'Return JSON flags, summary, and questions for a full single-bid review.'
            : 'Return JSON flags, summary, and questions. This is a free preview.',
        },
        { role: 'user', content: bidText },
      ],
    }),
  });
  if (!response.ok) {
    const error = new Error('model_failed');
    error.code = 'model_failed';
    throw error;
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  return JSON.parse(content);
}

function getModelClient() {
  if (process.env.NODE_ENV === 'test' && testClient) return testClient;
  if (!process.env.AI_API_KEY) return null;
  return defaultModelClient;
}

module.exports = { setModelClientForTests, getModelClient };
