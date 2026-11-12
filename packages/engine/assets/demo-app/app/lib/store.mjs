// Acme Repairs' data: repair jobs and shop settings, kept in memory. Every start (and every
// reset) begins from the same seed, so a walkthrough captured twice sees the same screens.
// Everything here is fictional: the people, the example.com addresses and the phone numbers,
// which are all in the 555-0100 to 555-0199 range set aside for fiction.

export const STATUSES = [
  { id: "waiting", label: "Waiting" },
  { id: "in-progress", label: "In progress" },
  { id: "ready", label: "Ready for pickup" },
  { id: "collected", label: "Collected" },
];

export const ITEM_TYPES = ["Bike", "Kitchen appliance", "Electronics", "Furniture", "Other"];

export const TURNAROUND_DAYS = [3, 5, 7, 10];

/** What each status moves on to, and the words for the move. */
export const NEXT_STEP = {
  waiting: { to: "in-progress", action: "Start work", history: "Work started" },
  "in-progress": { to: "ready", action: "Mark ready for pickup", history: "Ready for pickup" },
  ready: { to: "collected", action: "Mark as collected", history: "Collected by the customer" },
};

export function statusLabel(id) {
  return STATUSES.find((s) => s.id === id)?.label ?? id;
}

function job(number, name, phone, email, item, type, problem, status, history) {
  return { id: `J-${number}`, number, customer: { name, phone, email }, item, type, problem, status, history };
}

/** A fresh copy of the seed data. Newest job first. */
export function seedData() {
  return {
    nextNumber: 1043,
    settings: {
      shopName: "Acme Repairs, Harbour Street",
      phone: "(415) 555-0100",
      hours: "Mon to Fri, 9am to 5:30pm",
      turnaroundDays: 5,
      requireEmail: false,
    },
    jobs: [
      job(1042, "Priya Raman", "(415) 555-0142", "priya.raman@example.com", "Road bike", "Bike", "Gears slip under load. Rear derailleur probably needs adjusting.", "waiting", ["Taken in"]),
      job(1041, "Marcus Okafor", "(415) 555-0117", "marcus.okafor@example.com", "Espresso machine", "Kitchen appliance", "Pump runs but no water comes through.", "in-progress", ["Taken in", "Work started"]),
      job(1040, "Lena Fischer", "(415) 555-0163", "lena.fischer@example.com", "Laptop", "Electronics", "Left hinge cracked; lid won't stay open.", "ready", ["Taken in", "Work started", "Ready for pickup: new hinge fitted"]),
      job(1039, "Tomás Ibarra", "(415) 555-0128", "", "Sewing machine", "Other", "Needle jams on thick fabric.", "waiting", ["Taken in"]),
      job(1038, "Grace Mensah", "(415) 555-0181", "grace.mensah@example.com", "Stand mixer", "Kitchen appliance", "Grinding noise at high speed.", "in-progress", ["Taken in", "Work started"]),
      job(1037, "Owen Price", "(415) 555-0135", "owen.price@example.com", "Electric kettle", "Kitchen appliance", "Switch won't stay down.", "ready", ["Taken in", "Work started", "Ready for pickup: switch replaced"]),
      job(1036, "Aiko Tanaka", "(415) 555-0154", "aiko.tanaka@example.com", "Desk lamp", "Electronics", "Flickers when the arm is moved.", "collected", ["Taken in", "Work started", "Ready for pickup", "Collected by the customer"]),
      job(1035, "Hannah Kowalski", "(415) 555-0172", "hannah.kowalski@example.com", "Oak dining chair", "Furniture", "Back leg is loose.", "collected", ["Taken in", "Work started", "Ready for pickup", "Collected by the customer"]),
    ],
  };
}

const LIMITS = { name: 120, phone: 40, email: 160, item: 120, problem: 1000, shopName: 120, hours: 120, note: 300 };

const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createStore() {
  let data = seedData();

  return {
    /** Jobs matching a search (name, item, phone or job number) and a status, newest first. */
    listJobs({ q = "", status = "" } = {}) {
      const query = clean(q, 120).toLowerCase();
      return data.jobs.filter((j) => {
        if (status && j.status !== status) return false;
        if (!query) return true;
        return [j.id, j.customer.name, j.item, j.customer.phone, j.type].some((field) => field.toLowerCase().includes(query));
      });
    },

    counts() {
      const counts = { all: data.jobs.length };
      for (const s of STATUSES) counts[s.id] = data.jobs.filter((j) => j.status === s.id).length;
      return counts;
    },

    getJob(id) {
      return data.jobs.find((j) => j.id === id);
    },

    /** Validates and saves a new job. Returns `{ job }`, or `{ errors, values }` to show the form again. */
    createJob(input) {
      const values = {
        name: clean(input.name, LIMITS.name),
        phone: clean(input.phone, LIMITS.phone),
        email: clean(input.email, LIMITS.email),
        item: clean(input.item, LIMITS.item),
        type: clean(input.type, 40),
        problem: clean(input.problem, LIMITS.problem),
      };
      const errors = {};
      if (!values.name) errors.name = "Enter the customer's name";
      if (!values.phone) errors.phone = "Enter a phone number";
      else if (values.phone.replace(/\D/g, "").length < 7) errors.phone = "Enter a phone number with at least 7 digits";
      if (!values.email && data.settings.requireEmail) errors.email = "Enter an email address";
      else if (values.email && !EMAIL.test(values.email)) errors.email = "Enter an email address like name@example.com";
      if (!values.item) errors.item = "Enter the item being repaired";
      if (!ITEM_TYPES.includes(values.type)) errors.type = "Choose the type of item";
      if (!values.problem) errors.problem = "Describe what's wrong";
      if (Object.keys(errors).length > 0) return { errors, values };

      const created = job(data.nextNumber, values.name, values.phone, values.email, values.item, values.type, values.problem, "waiting", ["Taken in"]);
      data.nextNumber += 1;
      data.jobs.unshift(created);
      return { job: created };
    },

    /** Moves a job on one status. Returns the job, or undefined when that move isn't possible. */
    advance(id, to, note) {
      const found = data.jobs.find((j) => j.id === id);
      const step = found ? NEXT_STEP[found.status] : undefined;
      if (!found || !step || step.to !== to) return undefined;
      const text = clean(note, LIMITS.note);
      found.status = step.to;
      found.history.push(text ? `${step.history}: ${text}` : step.history);
      return found;
    },

    getSettings() {
      return { ...data.settings };
    },

    /** Validates and saves the shop settings. Returns `{ settings }` or `{ errors, values }`. */
    saveSettings(input) {
      const values = {
        shopName: clean(input.shopName, LIMITS.shopName),
        phone: clean(input.phone, LIMITS.phone),
        hours: clean(input.hours, LIMITS.hours),
        turnaroundDays: Number(input.turnaroundDays),
        requireEmail: input.requireEmail === "on",
      };
      const errors = {};
      if (!values.shopName) errors.shopName = "Enter the shop's name";
      if (!TURNAROUND_DAYS.includes(values.turnaroundDays)) errors.turnaroundDays = "Choose a standard turnaround";
      if (Object.keys(errors).length > 0) return { errors, values };
      data.settings = values;
      return { settings: { ...values } };
    },

    /** Puts every job and setting back to the seed. */
    reset() {
      data = seedData();
    },
  };
}
