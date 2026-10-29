#!/usr/bin/env node
// Temporary probe: Check booking 94409496 across Beds24 properties.
import { beds24GetJson } from 'C:/Users/kimko/nf-minpaku-automation/tools/gas-client.mjs';
import { PROPERTIES } from 'C:/Users/kimko/nf-minpaku-automation/tools/occupancy-target.mjs';

const BOOKING_ID = '94409496';

async function tryBooking(property) {
  const r = await beds24GetJson(`/bookings?propertyId=${property.propertyId}&id=${BOOKING_ID}`, property.facility);
  const rows = r?.data ?? [];
  if (rows.length > 0) {
    return { property, booking: rows[0], raw: r };
  }
  // Try without propertyId filter
  const r2 = await beds24GetJson(`/bookings?id=${BOOKING_ID}`, property.facility);
  const rows2 = r2?.data ?? [];
  if (rows2.length > 0) {
    return { property, booking: rows2[0], raw: r2 };
  }
  return null;
}

const out = { bookingId: BOOKING_ID, checkedAt: new Date().toISOString(), found: false, totalThreads: 0, hostReplyCount: 0, lastActivity: null, messages: [] };

for (const p of PROPERTIES) {
  const result = await tryBooking(p);
  if (result) {
    out.found = true;
    out.property = { key: p.key, label: p.label, propertyId: p.propertyId };
    out.booking = result.booking;

    // Get messages for this booking
    const msgs = await beds24GetJson(`/bookings/messages?bookingId=${BOOKING_ID}&maxAge=90`, result.property.facility);
    const msgRows = msgs?.data ?? [];
    out.totalThreads = msgRows.length;

    // Check each thread for host replies
    const threadDetails = [];
    for (const thread of msgRows) {
      const detail = {
        id: thread.id,
        subject: thread.subject ?? thread.subjectText ?? null,
        lastMessageTime: thread.lastMessageTime ?? thread.modifiedTime ?? null,
        isHost: thread.isHost ?? false,
        sentByProperty: thread.sentByProperty ?? thread.isFromProperty ?? thread.hostSent ?? false,
        messageCount: thread.messageCount ?? null,
        status: thread.status ?? null,
        channel: thread.channel ?? null,
      };
      threadDetails.push(detail);

      // Check if host reply
      const hasHostReply = detail.isHost || detail.sentByProperty;
      if (hasHostReply) out.hostReplyCount++;

      // Track last activity
      const ts = detail.lastMessageTime || detail.id;
      if (ts && (!out.lastActivity || ts > out.lastActivity)) out.lastActivity = ts;
    }
    out.messages = threadDetails;

    // Also check booking's own modifiedTime
    if (result.booking.modifiedTime && (!out.lastActivity || result.booking.modifiedTime > out.lastActivity)) {
      out.lastActivity = result.booking.modifiedTime;
    }

    break;
  }
}

console.log(JSON.stringify(out, null, 2));