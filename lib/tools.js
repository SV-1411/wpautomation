// Dental-clinic tools the agent can call. OpenAI/OpenRouter function-calling format.
import { createBooking, checkAvailability } from "./google.js";

const CLINIC = process.env.CLINIC_NAME || "BrightSmile Dental Clinic";

export const TOOLS = [
  {
    schema: {
      type: "function",
      function: {
        name: "check_availability",
        description:
          "Check which appointment times are free before offering them. Pass candidate slots as 'YYYY-MM-DD HH:MM' in 24h time. Use the clinic's open hours (Mon–Sat 9:00–19:00).",
        parameters: {
          type: "object",
          properties: {
            candidates: {
              type: "array",
              items: { type: "string" },
              description: "Candidate datetimes, e.g. ['2026-07-02 10:00','2026-07-02 16:30']",
            },
          },
          required: ["candidates"],
        },
      },
    },
    run: async ({ candidates }) => checkAvailability({ candidates }),
  },
  {
    schema: {
      type: "function",
      function: {
        name: "book_appointment",
        description:
          "Book a confirmed dental appointment. Only call once you have the patient's name, the service, and a specific date+time you've confirmed is free.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "patient full name" },
            phone: { type: "string", description: "contact number" },
            service: {
              type: "string",
              description: "e.g. Cleaning, Check-up, Whitening, Root canal, Braces consult, Emergency",
            },
            dateTime: { type: "string", description: "'YYYY-MM-DD HH:MM' in 24h time" },
            notes: { type: "string" },
          },
          required: ["name", "service", "dateTime"],
        },
      },
    },
    run: async (args) => createBooking(args),
  },
  {
    schema: {
      type: "function",
      function: {
        name: "clinic_info",
        description: "Get the clinic's address, hours, and services to answer patient questions accurately.",
        parameters: { type: "object", properties: {} },
      },
    },
    run: async () => ({
      name: CLINIC,
      hours: "Mon–Sat 9:00 AM – 7:00 PM, closed Sunday",
      address: process.env.CLINIC_ADDRESS || "123 MG Road, Nagpur",
      phone: process.env.CLINIC_PHONE || "+91 96236 88451",
      services: ["Cleaning & scaling", "Check-up", "Teeth whitening", "Fillings", "Root canal", "Braces / aligners", "Implants", "Emergency care"],
      newPatients: true,
    }),
  },
];

export const toolMap = Object.fromEntries(TOOLS.map((t) => [t.schema.function.name, t.run]));
export const toolSchemas = TOOLS.map((t) => t.schema);

export const SYSTEM_PROMPT = `You are the friendly AI receptionist for ${CLINIC} on WhatsApp.
Today's date is provided by the system at runtime. The clinic is open Mon–Sat 9:00–19:00, closed Sunday.

Your job: answer patient questions, recommend the right service, and BOOK appointments end-to-end.
Style: warm, concise, human — this is a chat. Short messages, no markdown headers, a little emoji is fine.

Booking flow:
1. Find out what they need (cleaning, check-up, pain/emergency, whitening, braces, etc.).
2. Ask for a preferred day/time. Convert vague times ("tomorrow afternoon") into concrete slots.
3. Call check_availability with 1–3 concrete candidate slots inside open hours before promising a time.
4. Get the patient's name (and phone if not known). Then call book_appointment.
5. Confirm back clearly: service, date, time. Never claim it's booked unless book_appointment returned ok.
For facts about the clinic (address, hours, services) call clinic_info — don't guess.`;
