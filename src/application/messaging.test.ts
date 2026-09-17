import { beforeEach, describe, expect, it } from 'vitest';
import {
  attachAvailabilityToMessage,
  markMessageRead,
  sendMessageToMasters,
  unhandledMessages,
} from './message-operations';
import { createAvailability } from './availability-operations';
import { assignPrimaryTechnician } from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, dayOffset, seedUser, type Harness } from './test-harness';
import { findJobAvailabilityConflicts } from '@/domain';

/**
 * Technician → Master messaging.
 *
 * The distinction the whole feature rests on: a message asks the office to do
 * something about availability; it never makes anyone unavailable by itself.
 * Only a Master's record does that, and only then does anything get blocked.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

describe('sending a message', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('records the sender, body and time', async () => {
    const message = await sendMessageToMasters(
      harness.as(sipho),
      "I've got a doctor's appointment today at 9am. I'll be back at 11am.",
    );

    expect(message.senderId).toBe(sipho.id);
    expect(message.body).toContain('doctor');
    expect(message.status).toBe('unread');
    expect(message.sentAt.length).toBeGreaterThan(0);
  });

  it('refuses an empty message', async () => {
    await expect(
      sendMessageToMasters(harness.as(sipho), '   '),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('notifies every active Master', async () => {
    await sendMessageToMasters(harness.as(sipho), 'Running late on the N1.');

    const users = await harness.repos.users.list();
    const masters = users.filter((user) => user.role === 'master' && user.active);
    expect(masters.length).toBeGreaterThan(0);

    for (const master of masters) {
      const notifications = await harness.repos.notifications.list(master.id);
      const message = notifications.find(
        (notification) => notification.type === 'technician_message',
      );
      expect(message?.title).toContain('Sipho Mahlangu');
      expect(message?.title).toContain('sent you a message');
    }
  });

  it('does NOT make the technician unavailable', async () => {
    await sendMessageToMasters(
      harness.as(sipho),
      "Doctor's appointment at 9am, back by 11am.",
    );

    // Nothing on the calendar...
    const records = await harness.repos.availability.listForUser(sipho.id);
    const today = records.filter(
      (record) => record.startDate <= dayOffset(0) && record.endDate >= dayOffset(0),
    );
    expect(today).toHaveLength(0);

    // ...so assignment still goes through. The office decides, not the message.
    const job = await harness.repos.jobs.findByJobNumber('EJE-1059');
    const scheduled = await harness.repos.jobs.save({
      ...job!,
      scheduledDate: dayOffset(0),
      primaryTechnicianId: null,
    });
    const saved = await assignPrimaryTechnician(
      harness.as(elmarie),
      scheduled,
      sipho.id,
      'Sipho Mahlangu',
    );
    expect(saved.primaryTechnicianId).toBe(sipho.id);
  });

  it('is audited as a message, and says it changes nothing by itself', async () => {
    await sendMessageToMasters(harness.as(sipho), 'Appointment at 9.');
    const trail = await harness.repos.activity.list();
    const entry = trail.find((event) => event.type === 'message_sent');
    expect(entry?.detail).toContain('does not change anyone');
  });
});

describe('a Master handling a message', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('marks it read without marking it handled', async () => {
    const message = await sendMessageToMasters(harness.as(sipho), 'Appointment at 9.');
    const read = await markMessageRead(harness.as(elmarie), message);

    expect(read.status).toBe('read');
    expect(read.readBy).toBe(elmarie.id);
    expect(unhandledMessages([read])).toHaveLength(1);
  });

  it('links the availability it created back to the message', async () => {
    const message = await sendMessageToMasters(
      harness.as(sipho),
      "Doctor's appointment at 9am, back by 11am.",
    );
    const { record } = await createAvailability(harness.as(elmarie), {
      userId: sipho.id,
      type: 'appointment',
      startDate: dayOffset(0),
      endDate: dayOffset(0),
      allDay: false,
      startTime: '09:00',
      endTime: '11:00',
      description: "Doctor's appointment.",
    });
    const actioned = await attachAvailabilityToMessage(harness.as(elmarie), message, record);

    expect(actioned.status).toBe('actioned');
    expect(actioned.availabilityRecordId).toBe(record.id);
    expect(actioned.actionedBy).toBe(elmarie.id);
    expect(unhandledMessages([actioned])).toHaveLength(0);
  });

  it('only then makes the technician unavailable', async () => {
    const message = await sendMessageToMasters(harness.as(sipho), 'Appointment at 9.');
    const { record } = await createAvailability(harness.as(elmarie), {
      userId: sipho.id,
      type: 'appointment',
      startDate: dayOffset(0),
      endDate: dayOffset(0),
      allDay: false,
      startTime: '09:00',
      endTime: '11:00',
      description: '',
    });
    await attachAvailabilityToMessage(harness.as(elmarie), message, record);

    const conflicts = findJobAvailabilityConflicts([record], sipho.id, {
      scheduledDate: dayOffset(0),
      scheduledEndDate: null,
      jobType: 'breakdown',
    });
    expect(conflicts).toHaveLength(1);
  });

  it('records "availability recorded" against the message on the trail', async () => {
    const message = await sendMessageToMasters(harness.as(sipho), 'Appointment at 9.');
    const { record } = await createAvailability(harness.as(elmarie), {
      userId: sipho.id,
      type: 'appointment',
      startDate: dayOffset(0),
      endDate: dayOffset(0),
      allDay: false,
      startTime: '09:00',
      endTime: '11:00',
      description: '',
    });
    await attachAvailabilityToMessage(harness.as(elmarie), message, record);

    const trail = await harness.repos.activity.list();
    const entry = trail.find((event) => event.type === 'message_actioned');
    expect(entry?.summary).toContain('Availability recorded');
    expect(entry?.detail).toContain('Elmarie');
  });

  it('keeps message history, including what was recorded', async () => {
    const seeded = await harness.repos.messages.list();
    const handled = seeded.find((message) => message.status === 'actioned');
    expect(handled?.availabilityRecordId).not.toBeNull();

    const linked = await harness.repos.availability.findById(handled!.availabilityRecordId!);
    expect(linked).not.toBeNull();
  });
});
