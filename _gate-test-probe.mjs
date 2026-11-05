// Gate test probe - testing if app-llm-cost-gate fires for Anthropic SDK imports
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
const response = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 100,
});