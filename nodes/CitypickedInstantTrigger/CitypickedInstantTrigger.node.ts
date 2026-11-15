import { createHmac, timingSafeEqual } from 'crypto';
import {
	NodeApiError,
	NodeConnectionTypes,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject,
} from 'n8n-workflow';

import { citypickedApiRequest, locationId, searchLocations } from '../Citypicked/GenericFunctions';

/**
 * The instant trigger (contract 1.2, docs/api-v1.md "Webhooks"): when the workflow is activated, n8n's webhook URL is
 * subscribed to one event (POST /v1/webhooks) and the id and signing secret are kept in the node's static data; when it
 * is deactivated, the webhook is deleted. Each delivery is checked (Citypicked-Signature: the HMAC-SHA256 of
 * "<t>.<raw body>" with the secret, t within 300 seconds) and its data starts the workflow: for feedback and requests
 * the object the polling trigger also returns; a Google review (1.5) has the event's own fields (reviewer_name,
 * replied, url), which the polled list item also has since 1.6, next to created_at, author, reply and can_reply; a
 * profile check point has the event's six fields, which the polled opening (1.7) also has, next to id and opened_at.
 * The polling "Citypicked Trigger" stays for n8n instances the API cannot reach (the URL must be https on a public
 * host).
 */
const EVENTS: Record<string, string> = {
	newFeedback: 'feedback.created',
	requestRated: 'request.rated',
	newFiveStarClick: 'request.public_click',
	// Contract 1.5. Both also have a polling twin (reviews 1.6, profile check points 1.7).
	newGoogleReview: 'google_review.created',
	profileCheckPointOpen: 'profile_check.point_opened',
};

const TOLERANCE_SEC = 300;

interface HookState {
	webhookId?: string;
	webhookSecret?: string;
	webhookUrl?: string;
}

/** The delivery's signature against the secret, in constant time; false for anything malformed or too old. */
export function signatureValid(header: string, rawBody: string, secret: string, nowMs: number): boolean {
	const parts: Record<string, string> = {};
	for (const part of header.split(',')) {
		const i = part.indexOf('=');
		if (i > 0) parts[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	if (!/^\d{9,11}$/.test(parts.t ?? '') || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
	if (Math.abs(nowMs / 1000 - Number(parts.t)) > TOLERANCE_SEC) return false;
	const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
	return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

export class CitypickedInstantTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Citypicked Instant Trigger',
		name: 'citypickedInstantTrigger',
		icon: { light: 'file:../../icons/citypicked.svg', dark: 'file:../../icons/citypicked.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description:
			'Starts the workflow right away when a customer rates, clicks through to a review site or leaves private feedback, a new Google review comes in or the profile check finds something to improve',
		defaults: { name: 'Citypicked Instant Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'citypickedApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				required: true,
				default: 'newFeedback',
				options: [
					{
						name: 'New 5-Star Click',
						value: 'newFiveStarClick',
						description:
							'A happy customer clicked through from your review page to a public review site, such as Google',
					},
					{
						name: 'New Google Review',
						value: 'newGoogleReview',
						description: 'Citypicked found a new review on your Google Business Profile',
					},
					{
						name: 'New Private Feedback',
						value: 'newFeedback',
						description: 'A customer left private feedback on your review page',
					},
					{
						name: 'Profile Check Point Open',
						value: 'profileCheckPointOpen',
						description:
							'The profile check found something to improve on your Google profile, such as too few photos',
					},
					{
						name: 'Request Rated',
						value: 'requestRated',
						description: 'A customer gave a star rating on your review page',
					},
				],
			},
			{
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
			},
		],
	};

	methods = {
		listSearch: { searchLocations },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as HookState;
				if (!state.webhookId) return false;
				try {
					const hook = await citypickedApiRequest.call(this, 'GET', `/webhooks/${encodeURIComponent(state.webhookId)}`);
					const event = EVENTS[this.getNodeParameter('event') as string];
					if (hook.url === this.getNodeWebhookUrl('default') && hook.status === 'active' && (hook.events as string[]).includes(event)) return true;
				} catch (error) {
					// 404: deleted in Citypicked (or the key was revoked); anything else is an error of the call.
					if (!(error instanceof NodeApiError && error.httpCode === '404')) {
						throw new NodeApiError(this.getNode(), error as JsonObject);
					}
				}
				// Gone, turned off or for another event: a new one is made.
				delete state.webhookId;
				delete state.webhookSecret;
				delete state.webhookUrl;
				return false;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default') as string;
				const event = EVENTS[this.getNodeParameter('event') as string];
				const hook = await citypickedApiRequest.call(this, 'POST', '/webhooks', {}, { url, events: [event] });
				if (typeof hook.id !== 'string' || typeof hook.secret !== 'string') {
					throw new NodeApiError(this.getNode(), hook as JsonObject, { message: 'Citypicked did not answer with a webhook.' });
				}
				const state = this.getWorkflowStaticData('node') as HookState;
				state.webhookId = hook.id;
				state.webhookSecret = hook.secret;
				state.webhookUrl = url;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as HookState;
				if (state.webhookId) {
					try {
						await citypickedApiRequest.call(this, 'DELETE', `/webhooks/${encodeURIComponent(state.webhookId)}`);
					} catch (error) {
						if (!(error instanceof NodeApiError) || error.httpCode !== '404') return false;
					}
				}
				delete state.webhookId;
				delete state.webhookSecret;
				delete state.webhookUrl;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const state = this.getWorkflowStaticData('node') as HookState;
		const req = this.getRequestObject() as unknown as { rawBody?: Buffer | string; headers: Record<string, string | string[] | undefined> };
		const header = req.headers['citypicked-signature'];
		const raw = req.rawBody === undefined ? '' : Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody);
		if (!state.webhookSecret || typeof header !== 'string' || !signatureValid(header, raw, state.webhookSecret, Date.now())) {
			const res = this.getResponseObject();
			res.status(401).send('Invalid signature').end();
			return { noWebhookResponse: true };
		}
		const body = this.getBodyData() as IDataObject;
		const event = EVENTS[this.getNodeParameter('event') as string];
		const data = body.data as IDataObject | undefined;
		const location = locationId(this.getNodeParameter('location', ''));
		if (body.type !== event || !data || (location && data.location_id !== location)) return { workflowData: [] };
		return { workflowData: [[{ json: data }]] };
	}
}
