import { expect,it } from 'vitest';
import { clientAppointmentsQuerySchema,compareClientAppointments } from '@/lib/client-appointments-pagination';
it('strict views forbid arbitrary UID limits and missing or extraneous calendar date',()=>{
 expect(clientAppointmentsQuerySchema.safeParse({version:1,view:'upcoming',uid:'other'}).success).toBe(false);
 expect(clientAppointmentsQuerySchema.safeParse({version:1,view:'calendar'}).success).toBe(false);
 expect(clientAppointmentsQuerySchema.safeParse({version:1,view:'upcoming',dateKey:'2030-01-07'}).success).toBe(false);
 expect(clientAppointmentsQuerySchema.safeParse({version:1,view:'calendar',dateKey:'2030-02-30'}).success).toBe(false);
});
it('stable ordinal ties and view direction are independent of locale',()=>{
 expect(compareClientAppointments('upcoming',{id:'A',startAt:2},{id:'b',startAt:2})).toBeLessThan(0);
 expect(compareClientAppointments('history',{id:'a',startAt:3},{id:'b',startAt:2})).toBeLessThan(0);
});
