import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type IHookFunctions,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type IN8nHttpFullResponse,
	type INodeListSearchResult,
	type IPollFunctions,
	type JsonObject,
} from 'n8n-workflow';

/** Every call of the Citypicked API v1 (docs/api-v1.md): Bearer key from the credentials, contract error shape. */
type Context = IExecuteFunctions | IPollFunctions | ILoadOptionsFunctions | IHookFunctions;

export const PRODUCTION_BASE_URL = 'https://api.citypicked.com/v1';

interface ApiError {
	code?: string;
	message?: string;
	field?: string;
}

async function baseUrl(context: Context): Promise<string> {
	const credentials = await context.getCredentials('citypickedApi');
	return String(credentials.baseUrl || PRODUCTION_BASE_URL).replace(/\/+$/, '');
}

function apiError(context: Context, response: IN8nHttpFullResponse): NodeApiError {
	const body = (response.body ?? {}) as { error?: ApiError };
	const error = body.error ?? {};
	const field = error.field ? ` (field: ${error.field})` : '';
	let description = error.code ? `Citypicked error code: ${error.code}` : undefined;
	if (response.statusCode === 401) {
		description = 'Make a new key in Citypicked under Settings > API and update the credential.';
	} else if (response.statusCode === 429) {
		const retryAfter = response.headers?.['retry-after'];
		description = `Too many calls. Try again in ${retryAfter ?? 60} seconds.`;
	}
	return new NodeApiError(context.getNode(), body as JsonObject, {
		httpCode: String(response.statusCode),
		message: `${error.message ?? `Citypicked answered with HTTP ${response.statusCode}.`}${field}`,
		description,
	});
}

export async function citypickedApiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	body?: IDataObject,
	headers: IDataObject = {},
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method,
		url: `${await baseUrl(this)}${path}`,
		qs,
		headers: { Accept: 'application/json', ...headers },
		json: true,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	};
	if (body !== undefined) options.body = body;
	const response = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'citypickedApi',
		options,
	)) as IN8nHttpFullResponse;
	if (response.statusCode >= 400) throw apiError(this, response);
	return response.body as IDataObject;
}

/** A file answer, such as the QR code PNG or SVG. */
export async function citypickedApiDownload(
	this: IExecuteFunctions,
	path: string,
	qs: IDataObject,
): Promise<{ data: Buffer; mimeType: string }> {
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'citypickedApi', {
		method: 'GET',
		url: `${await baseUrl(this)}${path}`,
		qs,
		encoding: 'arraybuffer',
		json: false,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	})) as IN8nHttpFullResponse;
	if (response.statusCode >= 400) {
		const text = Buffer.from(response.body as ArrayBuffer).toString('utf8');
		let parsed: IDataObject = {};
		try {
			parsed = JSON.parse(text) as IDataObject;
		} catch {
			parsed = {};
		}
		throw apiError(this, { ...response, body: parsed });
	}
	const contentType = String(response.headers?.['content-type'] ?? 'application/octet-stream');
	return { data: Buffer.from(response.body as ArrayBuffer), mimeType: contentType.split(';')[0] };
}

/**
 * Lists follow next_cursor (newest first). maxItems stops early; 0 means every page.
 */
export async function citypickedApiRequestAllItems(
	this: Context,
	path: string,
	qs: IDataObject = {},
	maxItems = 0,
): Promise<IDataObject[]> {
	const items: IDataObject[] = [];
	let cursor: string | undefined;
	do {
		const pageSize = maxItems > 0 ? Math.min(100, maxItems - items.length) : 100;
		const page = await citypickedApiRequest.call(this, 'GET', path, {
			...qs,
			limit: pageSize,
			...(cursor ? { cursor } : {}),
		});
		items.push(...((page.data as IDataObject[]) ?? []));
		cursor = (page.next_cursor as string | null) ?? undefined;
	} while (cursor && (maxItems === 0 || items.length < maxItems));
	return maxItems > 0 ? items.slice(0, maxItems) : items;
}

/** The location dropdown (resource locator, list mode). The API has no name filter, so the filter runs here. */
export async function searchLocations(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const locations = await citypickedApiRequestAllItems.call(this, '/locations');
	const wanted = (filter ?? '').trim().toLowerCase();
	return {
		results: locations
			.filter((l) => !wanted || String(l.name).toLowerCase().includes(wanted))
			.map((l) => ({ name: String(l.name), value: String(l.id), url: String(l.review_link ?? '') })),
	};
}

/** The id from a resource locator value, or undefined when it is empty. */
export function locationId(value: unknown): string | undefined {
	if (value && typeof value === 'object' && 'value' in value) {
		const v = (value as { value: unknown }).value;
		return v ? String(v) : undefined;
	}
	return value ? String(value) : undefined;
}
