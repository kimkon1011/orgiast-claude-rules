# Japan Trade Show Intake

Japan Trade Show Intake is a bilingual web application for overseas companies to record requirements for exhibiting at a trade show in Japan. It combines an intake form with a small, browser-local application manager.

## Intended use

Use the application to capture an exhibitor's company and contact details, target exhibition, preferred booth size and dates, requested support services, and additional questions. The interface is available in English and Japanese.

This build is a planning and demonstration tool. Completing the form does **not** transmit an application to a trade show organizer or confirm a booth reservation.

## Information collected

- Company name, optional Japanese company name, and country or region
- Website, contact name, email address, and optional phone number
- Exhibition or show name
- Preferred booth size and exhibit dates, including undecided options
- Requested services: booth design and construction, equipment, furniture, interpretation and staffing, catering, shipping and storage, marketing and printing, or other support
- Additional requests or questions

## Workflow

1. Select English or Japanese.
2. Enter the exhibition requirements and submit the form.
3. Review the locally generated reference ID.
4. Manage the entry as new, contacted, accepted, or cancelled.
5. Export records as CSV or Markdown when they need to be backed up or shared.

## Privacy and data handling

All records are stored only in the current browser's `localStorage`, using the key `expo-apply-data` and schema version 1. This version has no backend submission endpoint and makes no external API request. Data is not synchronized between browsers, devices, hostnames, or ports. Clearing browser data removes the records.

Users should avoid treating the local copy as a durable system of record and should export necessary records regularly. Anyone with access to the same browser profile may be able to view the saved entries.

## Technical requirements

The application needs a modern browser with JavaScript, ES modules, `localStorage`, and standard Web APIs. It has no package dependency, CDN, or web-font dependency. It should be served over HTTP or HTTPS rather than opened directly as a file.

## Limitations and claim boundaries

- No pricing, event availability, booth acceptance, organizer affiliation, or response time is promised.
- Status labels are local workflow labels, not statements by an exhibition organizer.
- The application does not provide legal, customs, safety, tax, or event-specific compliance advice.
- Current behavior should be verified against the interactive application and source before relying on it operationally.

## Related resources

- [Open the interactive application](./)
- [Frequently asked questions](faq.html)
- [Research and source notes](research.html)
- [AI index](llms.txt)
- [AI interpretation policy](ai.txt)
