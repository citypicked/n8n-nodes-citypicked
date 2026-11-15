import {
	NodeConnectionTypes,
	type IDataObject,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IPollFunctions,
} from 'n8n-workflow';

import {
	citypickedApiRequestAllItems,
	locationId,
	searchLocations,
} from '../Citypicked/GenericFunctions';

/**
 * The polling triggers of docs/api-v1.md. New Google Review reads GET /v1/reviews, whose since compares the time a
 * review reached Citypicked (created_at, 1.6), so a review Google hands over late is found like any other item.
 * Profile Check Point Open reads the open openings of GET /v1/profile-check/points (1.7), since on opened_at; a point
 * that is done and opens again is a new opening with a new id, so it starts the workflow again.
 */
const EVENTS: Record<string, { path: string; qs: IDataObject; item?: (raw: IDataObject) => IDataObject }> = {
	newFeedback: { path: '/feedback', qs: {} },
	requestRated: { path: '/requests', qs: { status: 'rated' } },
	newFiveStarClick: { path: '/requests', qs: { status: 'public_click' } },
	newGoogleReview: { path: '/reviews', qs: {} },
	profileCheckPointOpen: { path: '/profile-check/points', qs: { state: 'open' }, item: (o) => openingItem(o) },
};

/**
 * An opening as Profile Check Point Open gives it: the fields of the instant trigger's profile_check.point_opened, plus
 * the opening's id and opened_at. done_at is left out: only open points are asked for.
 */
function openingItem(o: IDataObject): IDataObject {
	return {
		location_id: o.location_id,
		point: o.point,
		title: o.title,
		hint: o.hint,
		score: o.score,
		url: o.url,
		id: o.id,
		opened_at: o.opened_at,
	};
}

/** Each poll asks for a little more than the time since the last one; ids already seen are dropped. */
const OVERLAP_MS = 2 * 60 * 1000;
const MAX_SEEN_IDS = 1000;
const MAX_ITEMS_PER_POLL = 1000;
/**
 * A review Google hands over more than this long after it was written came with a profile's first import, which brings
 * all its old reviews at once (1.6). The instant trigger's google_review.created leaves those out (it only takes
 * reviews up to 7 days old), so this trigger does too.
 */
export const REVIEW_LATE_MS = 8 * 24 * 60 * 60 * 1000;

const firstImport = (r: IDataObject) =>
	Date.parse(String(r.created_at)) - Date.parse(String(r.reviewed_at)) > REVIEW_LATE_MS;

interface PollState {
	lastTimeChecked?: string;
	seenIds?: string[];
}

const timestamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class CitypickedTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Citypicked Trigger',
		name: 'citypickedTrigger',
		icon: { light: 'file:../../icons/citypicked.svg', dark: 'file:../../icons/citypicked.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description:
			'Starts the workflow when a customer rates, clicks through to a review site or leaves private feedback, a new Google review comes in or the profile check finds something to improve',
		defaults: { name: 'Citypicked Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'citypickedApi', required: true }],
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

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = EVENTS[this.getNodeParameter('event') as string];
		const location = locationId(this.getNodeParameter('location', ''));
		const qs: IDataObject = { ...event.qs, ...(location ? { location_id: location } : {}) };
		const state = this.getWorkflowStaticData('node') as PollState;
		const now = Date.now();

		// A manual test run shows the newest item, new or not.
		const shape = event.item ?? ((raw: IDataObject) => raw);
		if (this.getMode() === 'manual') {
			const latest = await citypickedApiRequestAllItems.call(this, event.path, qs, 1);
			return latest.length ? [latest.map((raw) => ({ json: shape(raw) }))] : null;
		}

		const since = state.lastTimeChecked ? Date.parse(state.lastTimeChecked) - OVERLAP_MS : now - OVERLAP_MS;
		const listed = await citypickedApiRequestAllItems.call(
			this,
			event.path,
			{ ...qs, since: timestamp(since) },
			MAX_ITEMS_PER_POLL,
		);
		const items = event.path === '/reviews' ? listed.filter((r) => !firstImport(r)) : listed;
		const firstPoll = !state.lastTimeChecked;
		const seen = new Set(state.seenIds ?? []);
		const fresh = items.filter((item) => !seen.has(String(item.id)));
		state.seenIds = [...fresh.map((item) => String(item.id)), ...(state.seenIds ?? [])].slice(
			0,
			MAX_SEEN_IDS,
		);
		state.lastTimeChecked = timestamp(now);

		// The first poll after activation only remembers what is there: from now on, new items only.
		if (firstPoll || fresh.length === 0) return null;
		return [fresh.reverse().map((raw) => ({ json: shape(raw) }))];
	}
}
