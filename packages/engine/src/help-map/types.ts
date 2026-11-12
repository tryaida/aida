// public/help-map.json: which published guides belong to which screens of the documented app, so
// the in-app widget (help app public/widget.js) can offer "Help for this screen" with no model and
// no key. Screen patterns use routes/pattern.ts syntax (`*` one segment, `**` the rest).

export interface HelpMapGuide {
  /** Walkthrough id. */
  id: string;
  title: string;
  /** The guide's page on the help site, site-relative, e.g. "/how-do-i/payments/record-a-payment". */
  url: string;
  /** Who the guide is for (Walkthrough.for), when set. */
  for?: string;
  /** One plain sentence (Walkthrough.summary, markdown stripped), when the walkthrough has one. */
  summary?: string;
  /** Number of published steps. */
  steps: number;
  /** Screen pattern of the page the guide starts on; absent when the walkthrough names no start
   * page. */
  starts?: string;
  /** Other screens the guide passes through or can start from (another way in), sorted, without
   * `starts`. */
  screens: string[];
  /** Present when the guide has an in-app tour file (public/tours/<id>.json). */
  tour?: true;
}

export interface HelpMap {
  version: 1;
  guides: HelpMapGuide[];
}
