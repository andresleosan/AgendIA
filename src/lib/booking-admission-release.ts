import { z } from 'zod';

export type BookingAdmissionRelease = 'prepare' | 'enforce';
export const BOOKING_ADMISSION_RELEASE: BookingAdmissionRelease = 'prepare';
export const BOOKING_ADMISSION_COMPATIBILITY = { reader: 2, release: BOOKING_ADMISSION_RELEASE, recoveryCompatible: false } as const;
export const bookingAdmissionProtocolSchema = z.object({ version: z.literal(1), minimumReader: z.literal(2), introducedBySha: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export type BookingAdmissionProtocol = z.infer<typeof bookingAdmissionProtocolSchema>;
