import { describe, expect, it } from 'vitest'
import {
  buildStudioSystemPrompt,
  getSystemPrompt,
  HERMES_MCP_USAGE_GUIDELINES,
} from '../../packages/server/src/lib/llm-prompt'

describe('LLM prompt', () => {
  it('is bare by default: no managed injection blocks beyond the custom prompt', () => {
    const prompt = getSystemPrompt('custom instructions')

    expect(prompt).toContain('custom instructions')
    expect(prompt).not.toContain('hermes_studio_api_openapi_get')
    expect(prompt).not.toContain('hermes_studio_api_request')
    expect(prompt).not.toContain('内部委托')
    expect(prompt).not.toContain('输出格式规范')
  })

  it('returns an empty string when there is no custom prompt and no injections', () => {
    expect(getSystemPrompt()).toBe('')
  })

  it('includes Hermes MCP usage guidance only when explicitly requested', () => {
    const prompt = buildStudioSystemPrompt('custom instructions', {
      inject: [{ kind: 'mcp-usage' }],
    })

    expect(prompt).toContain('custom instructions')
    expect(prompt).toContain('hermes_studio_api_openapi_get')
    expect(prompt).toContain('hermes_studio_api_request')
    expect(prompt).toContain('OpenAPI requestBody')
    expect(prompt).toContain('do not add Authorization headers')
    expect(prompt).toContain('Do not use hermes_studio_use_chat_run')
    expect(prompt).toContain('return the delegated result in the current task instead')
    expect(prompt).not.toContain('hermes://openapi.json')
    expect(prompt).not.toContain('[Current Hermes profile:')
  })

  it('output-format block is included only when the output-format injection is requested', () => {
    const prompt = buildStudioSystemPrompt(undefined, { inject: [{ kind: 'output-format' }] })
    expect(prompt).toContain('输出格式规范')
    expect(prompt).not.toContain('hermes_studio_api_request')
  })

  it('does not duplicate the MCP usage block across call sites', () => {
    const prompt = buildStudioSystemPrompt('instructions', {
      inject: [{ kind: 'mcp-usage' }, { kind: 'mcp-usage' }],
    })
    const count = prompt.split(HERMES_MCP_USAGE_GUIDELINES[0]).length - 1
    expect(count).toBe(2)
  })
})