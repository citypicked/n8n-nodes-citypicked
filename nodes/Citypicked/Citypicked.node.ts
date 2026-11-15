import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import {
	citypickedApiDownload,
	citypickedApiRequest,
	citypickedApiRequestAllItems,
	locationId,
	searchLocations,
} from './GenericFunctions';

/** Outcomes of POST /v1/requests the user has to act on: they fail the item with the reason. */
const FAILING_OUTCOMES = ['invalid', 'no_credits', 'consent_method_missing'];

function locationField(overrides: Partial<INodeProperties> = {}): INodeProperties {
	return {
		displayName: 'Location',
		name: 'location',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		description: 'Only for this location. Leave empty for all your locations.',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchLocations', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 0f8e6d4c-2b1a-4c9e-8f7d-5e3c1a9b7d5f',
			},
		],
		...overrides,
	} as INodeProperties;
}

function show(resource: string, operation: string[], extra: IDataObject = {}) {
	return { show: { resource: [resource], operation, ...extra } };
}

const requestStatusFilter: INodeProperties = {
	displayName: 'Status',
	name: 'status',
	type: 'options',
	default: 'rated',
	options: [
		{ name: 'Canceled', value: 'canceled' },
		{ name: 'Clicked', value: 'clicked' },
		{ name: 'Delivered', value: 'delivered' },
		{ name: 'Failed', value: 'failed' },
		{ name: 'Feedback', value: 'feedback' },
		{ name: 'Public Click', value: 'public_click' },
		{ name: 'Rated', value: 'rated' },
		{ name: 'Scheduled', value: 'scheduled' },
		{ name: 'Sent', value: 'sent' },
	],
};

const feedbackStatusFilter: INodeProperties = {
	displayName: 'Status',
	name: 'status',
	type: 'options',
	default: 'new',
	options: [
		{ name: 'In Progress', value: 'in_progress' },
		{ name: 'New', value: 'new' },
		{ name: 'Resolved', value: 'resolved' },
	],
};

function getManyFields(resource: string, noun: string, statusFilter: INodeProperties): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			displayOptions: show(resource, ['getAll']),
			default: false,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			displayOptions: show(resource, ['getAll'], { returnAll: [false] }),
			typeOptions: { minValue: 1 },
			default: 50,
			description: 'Max number of results to return',
		},
		{
			displayName: 'Filters',
			name: 'filters',
			type: 'collection',
			placeholder: 'Add Filter',
			displayOptions: show(resource, ['getAll']),
			default: {},
			options: [
				locationField({ description: `Only ${noun} for this location` }),
				{
					displayName: 'Since',
					name: 'since',
					type: 'dateTime',
					default: '',
					description: `Only ${noun} created at or after this time`,
				},
				statusFilter,
			],
		},
	];
}

const sendFields: INodeProperties[] = [
	locationField({
		displayOptions: show('request', ['send']),
		description:
			'The location the customer visited. Leave empty when your Citypicked account has one location.',
	}),
	{
		displayName: 'Channel',
		name: 'channel',
		type: 'options',
		required: true,
		displayOptions: show('request', ['send']),
		default: 'email',
		description:
			'How the review request reaches the customer. WhatsApp messages go out from your own phone: open the WhatsApp link in the output.',
		options: [
			{ name: 'Email', value: 'email' },
			{ name: 'SMS', value: 'sms' },
			{ name: 'WhatsApp', value: 'whatsapp' },
		],
	},
	{
		displayName: 'Customer Email',
		name: 'email',
		type: 'string',
		placeholder: 'e.g. anna@example.org',
		required: true,
		displayOptions: show('request', ['send'], { channel: ['email'] }),
		default: '',
		description: 'Where the review request goes',
	},
	{
		displayName: 'Customer Phone',
		name: 'phone',
		type: 'string',
		placeholder: 'e.g. +12015550123',
		required: true,
		displayOptions: show('request', ['send'], { channel: ['sms', 'whatsapp'] }),
		default: '',
		description: 'Mobile number in international format',
	},
	{
		displayName: 'Customer Name',
		name: 'customerName',
		type: 'string',
		displayOptions: show('request', ['send']),
		default: '',
		description: 'Used to greet the customer, for example "Hi Anna"',
	},
	{
		displayName: 'Customer Agreed to Get This Message',
		name: 'consent',
		type: 'boolean',
		displayOptions: show('request', ['send']),
		default: false,
		description:
			'Whether the customer agreed to hear from you, for example when they booked. Citypicked sends nothing without it.',
	},
	{
		displayName: 'Consent Method',
		name: 'consentMethod',
		type: 'options',
		displayOptions: show('request', ['send'], { channel: ['sms'] }),
		default: '',
		description: 'How the customer agreed to get texts. Required for SMS to US and Canadian numbers.',
		options: [
			{ name: 'Agreed in Person', value: 'in_person' },
			{ name: 'Agreed in Writing', value: 'written' },
			{ name: 'Agreed on a Form', value: 'form' },
			{ name: 'Agreed When Booking', value: 'booking' },
			{ name: 'None', value: '' },
		],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		displayOptions: show('request', ['send']),
		default: {},
		options: [
			{
				displayName: 'Booking or Order ID',
				name: 'bookingId',
				type: 'string',
				default: '',
				description:
					'The ID of the booking or order. When the same ID comes in again within 24 hours, Citypicked does not send twice.',
			},
			{
				displayName: 'Send At',
				name: 'sendAt',
				type: 'dateTime',
				default: '',
				description:
					'When to send, up to 30 days ahead, for example two hours after the appointment. Empty sends now, within your sending hours.',
			},
		],
	},
];

export class Citypicked implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Citypicked',
		name: 'citypicked',
		icon: { light: 'file:../../icons/citypicked.svg', dark: 'file:../../icons/citypicked.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send review requests and read ratings, feedback and stats from Citypicked',
		defaults: { name: 'Citypicked' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'citypickedApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Feedback', value: 'feedback' },
					{ name: 'Location', value: 'location' },
					{ name: 'Request', value: 'request' },
					{ name: 'Statistic', value: 'stats' },
				],
				default: 'request',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['request'] } },
				options: [
					{ name: 'Get', value: 'get', description: 'Get one review request', action: 'Get a request' },
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get many review requests, newest first',
						action: 'Get many requests',
					},
					{
						name: 'Send',
						value: 'send',
						description: 'Send a review request to a customer',
						action: 'Send a review request',
					},
				],
				default: 'send',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['feedback'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get many private feedback items, newest first',
						action: 'Get many feedback items',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['location'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get many locations with their review links',
						action: 'Get many locations',
					},
					{
						name: 'Get Review Link',
						value: 'getReviewLink',
						description: 'Get the review link and QR code of a location',
						action: 'Get the review link of a location',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['stats'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get review request statistics for a date range',
						action: 'Get statistics',
					},
				],
				default: 'get',
			},

			...sendFields,
			{
				displayName: 'Request ID',
				name: 'requestId',
				type: 'string',
				required: true,
				displayOptions: show('request', ['get']),
				default: '',
				description: 'The ID of the review request',
			},
			...getManyFields('request', 'requests', requestStatusFilter),
			...getManyFields('feedback', 'feedback', feedbackStatusFilter),
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				displayOptions: show('location', ['getAll']),
				default: false,
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				displayOptions: show('location', ['getAll'], { returnAll: [false] }),
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
			},
			locationField({
				required: true,
				displayOptions: show('location', ['getReviewLink']),
				description: 'The location whose review link you want',
			}),
			{
				displayName: 'Download QR Code',
				name: 'downloadQrCode',
				type: 'boolean',
				displayOptions: show('location', ['getReviewLink']),
				default: false,
				description: 'Whether to also download the QR code as a file',
			},
			{
				displayName: 'QR Code Format',
				name: 'qrFormat',
				type: 'options',
				displayOptions: show('location', ['getReviewLink'], { downloadQrCode: [true] }),
				default: 'png',
				options: [
					{ name: 'PNG', value: 'png', description: '1024 pixels, for most uses' },
					{ name: 'SVG', value: 'svg', description: 'For print' },
				],
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				displayOptions: show('location', ['getReviewLink'], { downloadQrCode: [true] }),
				default: 'data',
				hint: 'The name of the output binary field to put the file in',
			},
			locationField({
				displayOptions: show('stats', ['get']),
				description: 'Only for this location. Leave empty for all your locations.',
			}),
			{
				displayName: 'Date Range',
				name: 'dateRange',
				type: 'collection',
				placeholder: 'Add Date',
				displayOptions: show('stats', ['get']),
				default: {},
				description: 'Without dates, the stats cover the last 30 days',
				options: [
					{
						displayName: 'From',
						name: 'from',
						type: 'dateTime',
						default: '',
						description: 'First day of the range',
					},
					{
						displayName: 'To',
						name: 'to',
						type: 'dateTime',
						default: '',
						description: 'Last day of the range',
					},
				],
			},
		],
	};

	methods = {
		listSearch: { searchLocations },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const out = await runOperation.call(this, resource, operation, i);
				returnData.push(...out.map((item) => ({ ...item, pairedItem: { item: i } })));
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// API and operation errors already carry the HTTP status and the reason; anything else gets wrapped.
				const failure =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				throw failure;
			}
		}
		return [returnData];
	}
}

function toTimestamp(value: unknown): string | undefined {
	if (!value) return undefined;
	const date = new Date(String(value));
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toDay(value: unknown): string | undefined {
	return value ? String(value).slice(0, 10) : undefined;
}

async function getMany(this: IExecuteFunctions, path: string, i: number): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', i) as boolean;
	const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const qs: IDataObject = {};
	const location = locationId(filters.location);
	if (location) qs.location_id = location;
	if (filters.status) qs.status = filters.status;
	const since = toTimestamp(filters.since);
	if (since) qs.since = since;
	return await citypickedApiRequestAllItems.call(this, path, qs, limit);
}

async function sendRequest(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const channel = this.getNodeParameter('channel', i) as string;
	const contact: IDataObject = {};
	const name = (this.getNodeParameter('customerName', i, '') as string).trim();
	if (name) contact.name = name;
	if (channel === 'email') contact.email = (this.getNodeParameter('email', i) as string).trim();
	else contact.phone = (this.getNodeParameter('phone', i) as string).trim();

	const body: IDataObject = {
		channel,
		consent: this.getNodeParameter('consent', i, false) as boolean,
		contacts: [contact],
	};
	const location = locationId(this.getNodeParameter('location', i, ''));
	if (location) body.location_id = location;
	if (channel === 'sms') {
		const consentMethod = this.getNodeParameter('consentMethod', i, '') as string;
		if (consentMethod) body.consent_method = consentMethod;
	}
	const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	const headers: IDataObject = {};
	const bookingId = String(additional.bookingId ?? '').trim();
	if (bookingId) headers['Idempotency-Key'] = `${channel}:${bookingId}`.slice(0, 200);
	if (additional.sendAt) {
		const sendAt = toTimestamp(additional.sendAt);
		if (!sendAt) {
			throw new NodeOperationError(this.getNode(), 'Send At is not a date and time Citypicked can read.', {
				itemIndex: i,
			});
		}
		body.send_at = sendAt;
	}

	const answer = await citypickedApiRequest.call(this, 'POST', '/requests', {}, body, headers);
	const result = ((answer.results as IDataObject[]) ?? [])[0] ?? {};
	const outcome = String(result.outcome ?? '');
	if (FAILING_OUTCOMES.includes(outcome)) {
		const reason =
			outcome === 'consent_method_missing'
				? 'SMS to US and Canadian numbers needs a consent method. Pick one in Consent Method.'
				: String(result.message ?? 'Citypicked could not send this review request.');
		throw new NodeOperationError(this.getNode(), `Citypicked did not send this review request: ${reason}`, {
			itemIndex: i,
			description: `Outcome: ${outcome}`,
		});
	}
	return {
		request_id: result.request_id ?? null,
		outcome,
		message: result.message ?? null,
		created: answer.created,
		channel,
		location_id: location ?? null,
		whatsapp_url: result.whatsapp_url ?? null,
	};
}

async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	const json = (data: IDataObject | IDataObject[]) =>
		(Array.isArray(data) ? data : [data]).map((d) => ({ json: d }));

	if (resource === 'request' && operation === 'send') return json(await sendRequest.call(this, i));
	if (resource === 'request' && operation === 'get') {
		const id = encodeURIComponent((this.getNodeParameter('requestId', i) as string).trim());
		return json(await citypickedApiRequest.call(this, 'GET', `/requests/${id}`));
	}
	if (resource === 'request' && operation === 'getAll') return json(await getMany.call(this, '/requests', i));
	if (resource === 'feedback' && operation === 'getAll') return json(await getMany.call(this, '/feedback', i));
	if (resource === 'location' && operation === 'getAll') {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		return json(await citypickedApiRequestAllItems.call(this, '/locations', {}, limit));
	}
	if (resource === 'location' && operation === 'getReviewLink') {
		const id = locationId(this.getNodeParameter('location', i));
		if (!id) throw new NodeOperationError(this.getNode(), 'Pick a location.', { itemIndex: i });
		const path = `/locations/${encodeURIComponent(id)}/review-link`;
		const link = await citypickedApiRequest.call(this, 'GET', path, { format: 'json' });
		if (!(this.getNodeParameter('downloadQrCode', i, false) as boolean)) return json(link);
		const format = this.getNodeParameter('qrFormat', i, 'png') as string;
		const field = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
		const file = await citypickedApiDownload.call(this, path, { format });
		const binary = await this.helpers.prepareBinaryData(file.data, `citypicked-review-qr.${format}`, file.mimeType);
		return [{ json: link, binary: { [field]: binary } }];
	}
	if (resource === 'stats' && operation === 'get') {
		const qs: IDataObject = {};
		const location = locationId(this.getNodeParameter('location', i, ''));
		if (location) qs.location_id = location;
		const range = this.getNodeParameter('dateRange', i, {}) as IDataObject;
		const from = toDay(range.from);
		const to = toDay(range.to);
		if (from) qs.from = from;
		if (to) qs.to = to;
		return json(await citypickedApiRequest.call(this, 'GET', '/stats', qs));
	}
	throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not known for "${resource}"`, {
		itemIndex: i,
	});
}
