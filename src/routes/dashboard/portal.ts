import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';

/** Order the endpoint reference groups the same way the tags are declared in swagger.ts. */
const TAG_ORDER = ['system', 'numbers', 'messages', 'contacts', 'templates', 'broadcasts', 'groups', 'health'];

/** Paths where a live JSON round-trip in the console doesn't make sense
 *  (multipart upload, or binary/HTML responses) — still documented, just not
 *  wired into the "try it" console's endpoint picker. */
function consoleSupported(method: string, path: string): boolean {
  if (path.endsWith('/upload')) return false;
  if (path.endsWith('/qr.png') || path.endsWith('/qr/live')) return false;
  if (method === 'GET' && path.endsWith('/media')) return false;
  return true;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  description?: string;
  example?: unknown;
  minimum?: number;
  maximum?: number;
}

/** Walks a JSON-schema object and produces a plausible example value —
 *  used both to render a request-body example in the docs and to pre-fill
 *  the console's editable body textarea. */
function exampleFromSchema(schema: JsonSchema | undefined): unknown {
  if (!schema) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.enum?.length) return schema.enum[0];

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') ?? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      for (const [key, propSchema] of Object.entries(props)) {
        if (required.size > 0 && !required.has(key)) continue;
        out[key] = exampleFromSchema(propSchema);
      }
      // No required fields declared — show every property so the shape is clear.
      if (required.size === 0) {
        for (const [key, propSchema] of Object.entries(props)) out[key] = exampleFromSchema(propSchema);
      }
      return out;
    }
    case 'array':
      return [exampleFromSchema(schema.items)];
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return false;
    case 'string':
    default:
      return '';
  }
}

interface ParamView {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  type: string;
  description: string;
  enum?: unknown[];
}

interface EndpointView {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  pathParams: ParamView[];
  queryParams: ParamView[];
  bodyExample: unknown;
  hasBody: boolean;
  curl: string;
  consoleEnabled: boolean;
}

interface GroupView {
  tag: string;
  label: string;
  endpoints: EndpointView[];
}

interface WebhookSchemaView {
  name: string;
  description: string;
  fields: { name: string; type: string; description: string }[];
}

const TAG_LABELS: Record<string, string> = {
  system: 'System',
  numbers: 'Numbers',
  messages: 'Messages',
  contacts: 'Contacts',
  templates: 'Templates',
  broadcasts: 'Broadcasts',
  groups: 'Groups',
  health: 'Health',
};

function schemaTypeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return '';
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type ?? '';
  return schema.enum ? `${type} (${schema.enum.map(String).join(', ')})` : type;
}

function buildCurl(method: string, path: string, baseUrl: string, pathParams: ParamView[], hasBody: boolean, bodyExample: unknown): string {
  let urlPath = path;
  for (const p of pathParams) urlPath = urlPath.replace(`{${p.name}}`, `<${p.name}>`);
  const parts = [`curl -X ${method} "${baseUrl}${urlPath}"`, `-H "Authorization: Bearer <token>"`];
  if (hasBody) {
    parts.push(`-H "Content-Type: application/json"`);
    parts.push(`-d '${JSON.stringify(bodyExample)}'`);
  }
  return parts.join(' \\\n  ');
}

/** Builds the portal's view model straight from the live OpenAPI document
 *  (app.swagger()), so the docs and console can never drift from the real API. */
export function buildPortalData(app: FastifyInstance) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = app.swagger() as any;
  const groupsByTag = new Map<string, EndpointView[]>();

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods as Record<string, any>)) {
      const tag = op.tags?.[0];
      if (!tag || tag === 'dashboard (internal)') continue;

      const allParams: any[] = op.parameters ?? [];
      const pathParams: ParamView[] = allParams
        .filter((p) => p.in === 'path')
        .map((p) => ({ name: p.name, in: 'path' as const, required: true, type: schemaTypeLabel(p.schema), description: p.description ?? '', enum: p.schema?.enum }));
      const queryParams: ParamView[] = allParams
        .filter((p) => p.in === 'query')
        .map((p) => ({ name: p.name, in: 'query' as const, required: !!p.required, type: schemaTypeLabel(p.schema), description: p.description ?? '', enum: p.schema?.enum }));

      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      const hasBody = !!bodySchema;
      const bodyExample = hasBody ? exampleFromSchema(bodySchema) : undefined;
      const upperMethod = method.toUpperCase();

      const endpoint: EndpointView = {
        id: `${upperMethod}_${path}`.replace(/[{}/]/g, '_'),
        method: upperMethod,
        path,
        summary: op.summary ?? '',
        description: op.description ?? '',
        pathParams,
        queryParams,
        bodyExample,
        hasBody,
        curl: buildCurl(upperMethod, path, config.publicBaseUrl, pathParams, hasBody, bodyExample),
        consoleEnabled: consoleSupported(upperMethod, path),
      };

      if (!groupsByTag.has(tag)) groupsByTag.set(tag, []);
      groupsByTag.get(tag)!.push(endpoint);
    }
  }

  const groups: GroupView[] = TAG_ORDER.filter((t) => groupsByTag.has(t)).map((tag) => ({
    tag,
    label: TAG_LABELS[tag] ?? tag,
    endpoints: groupsByTag.get(tag)!,
  }));

  const webhookSchemas: WebhookSchemaView[] = Object.entries(spec.components?.schemas ?? {})
    .filter(([name]) => name.startsWith('Webhook') && name !== 'WebhookEnvelope')
    .map(([name, schema]: [string, any]) => ({
      name,
      description: schema.description ?? '',
      fields: Object.entries(schema.properties ?? {}).map(([fname, fschema]: [string, any]) => ({
        name: fname,
        type: schemaTypeLabel(fschema),
        description: fschema.description ?? '',
      })),
    }));

  return { groups, webhookSchemas, baseUrl: config.publicBaseUrl };
}

/** Shared doc metadata so the portal route appears grouped under "dashboard (internal)"
 *  in the raw Swagger UI, matching the other server-rendered pages. */
const dash = (summary: string, description: string) => ({
  schema: { tags: ['dashboard (internal)'], summary, description, security: [] as never[] },
});

/**
 * The developer portal: a human-friendly API reference (grouped by area, with
 * curl snippets and request-body examples) plus a live "try it" console.
 * Public like /docs — downstream developers won't have an admin session.
 */
export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/developers',
    dash('Developer portal', 'HTML. Human-friendly API reference and interactive console, generated from the live OpenAPI spec.'),
    async (_req, reply) => {
      const data = buildPortalData(app);
      return reply.view('portal', { active: 'developers', ...data });
    },
  );
}
