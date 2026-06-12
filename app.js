const siteConfig = {
  services: [
    {
      label: "Shiatsu",
      title: "Shiatsu 90 minut",
      duration: "90 minut",
      price: "1 500 Kč",
      description:
        "Celostní ošetření v pohodlném oblečení. Zahrnuje krátký rozhovor, samotnou práci s tělem a prostor na doznění.",
      bookingValue: "Shiatsu 90 minut",
    },
  ],
};

const state = {
  currentMonth: startOfMonth(new Date()),
  selectedDate: null,
  selectedSlot: null,
  slots: [],
  timezone: "Europe/Prague",
  loading: false,
};

const els = {
  body: document.body,
  menuToggle: document.querySelector("[data-menu-toggle]"),
  menu: document.querySelector("[data-menu]"),
  monthLabel: document.querySelector("[data-month-label]"),
  prevMonth: document.querySelector("[data-prev-month]"),
  nextMonth: document.querySelector("[data-next-month]"),
  calendarGrid: document.querySelector("[data-calendar-grid]"),
  selectedDay: document.querySelector("[data-selected-day]"),
  timeList: document.querySelector("[data-time-list]"),
  selectedSlot: document.querySelector("[data-selected-slot]"),
  bookingMode: document.querySelector("[data-booking-mode]"),
  form: document.querySelector("[data-booking-form]"),
  submit: document.querySelector("[data-submit-booking]"),
  formStatus: document.querySelector("[data-form-status]"),
  serviceGrid: document.querySelector("[data-service-grid]"),
  priceGrid: document.querySelector("[data-price-grid]"),
  bookingServiceLabel: document.querySelector("[data-booking-service-label]"),
  bookingServiceInput: document.querySelector("[data-booking-service-input]"),
  year: document.querySelector("[data-year]"),
};

const monthFormatter = new Intl.DateTimeFormat("cs-CZ", {
  month: "long",
  year: "numeric",
});

const API_BASE_URL = (window.SHIATSU_API_BASE_URL || "").replace(/\/$/, "");

const dayFormatter = new Intl.DateTimeFormat("cs-CZ", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

document.addEventListener("DOMContentLoaded", () => {
  els.year.textContent = new Date().getFullYear();
  renderConfiguredContent();
  bindNavigation();
  bindBooking();
  loadSlots();
});

function renderConfiguredContent() {
  const services = siteConfig.services;
  const primaryService = services[0];

  if (primaryService && els.bookingServiceLabel && els.bookingServiceInput) {
    els.bookingServiceLabel.textContent = primaryService.bookingValue;
    els.bookingServiceInput.value = primaryService.bookingValue;
  }

  if (els.serviceGrid) {
    els.serviceGrid.classList.toggle("is-single", services.length === 1);
    els.serviceGrid.innerHTML = services
      .map(
        (service, index) => `
          <article class="service-card">
            <span class="service-icon">${String(index + 1).padStart(2, "0")}</span>
            <h3>${escapeHtml(service.title)}</h3>
            <p>${escapeHtml(service.description)}</p>
          </article>
        `,
      )
      .join("");
  }

  if (els.priceGrid) {
    els.priceGrid.classList.toggle("is-single", services.length === 1);
    els.priceGrid.innerHTML = services
      .map(
        (service, index) => `
          <article class="price-card ${index === 0 ? "featured" : ""}">
            <div>
              <p class="price-label">${escapeHtml(service.label)}</p>
              <h3>${escapeHtml(service.duration)}</h3>
              <p>${escapeHtml(service.description)}</p>
            </div>
            <strong>${escapeHtml(service.price)}</strong>
          </article>
        `,
      )
      .join("");
  }
}

function bindNavigation() {
  if (els.menuToggle) {
    els.menuToggle.addEventListener("click", () => {
      els.body.classList.toggle("menu-open");
    });
  }

  if (els.menu) {
    els.menu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => els.body.classList.remove("menu-open"));
    });
  }
}

function bindBooking() {
  els.prevMonth.addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, -1);
    state.selectedDate = null;
    state.selectedSlot = null;
    loadSlots();
  });

  els.nextMonth.addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, 1);
    state.selectedDate = null;
    state.selectedSlot = null;
    loadSlots();
  });

  els.form.addEventListener("submit", submitBooking);
}

async function loadSlots() {
  state.loading = true;
  state.selectedSlot = null;
  updateFormState();
  renderCalendarSkeleton();

  const gridStart = startOfCalendarGrid(state.currentMonth);
  const from = formatDateKey(gridStart);
  const to = formatDateKey(addDays(gridStart, 41));

  try {
    const response = await fetch(apiUrl(`/api/slots?from=${from}&to=${to}`), {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error("Nepodařilo se načíst dostupné termíny.");
    }

    const data = await response.json();
    state.slots = Array.isArray(data.slots) ? data.slots : [];
    state.timezone = data.timezone || state.timezone;

    let modeLabel = data.mode === "demo" ? "Demo režim: po nastavení Google Calendar se zde zobrazí skutečné termíny." : "";
    if (Array.isArray(data.warnings) && data.warnings.length > 0) {
      modeLabel = data.warnings.join(" ");
    } else if (data.mode === "google" && state.slots.length === 0) {
      modeLabel = "Google Calendar je připojený, ale zatím nevrátil žádné volné termíny.";
    }
    els.bookingMode.textContent = modeLabel;
    els.bookingMode.classList.toggle("is-hidden", !modeLabel);
    els.bookingMode.classList.toggle("is-error", data.mode === "google" && state.slots.length === 0);

    const firstAvailable = state.slots.find((slot) => slot.status === "available");
    if (!state.selectedDate && firstAvailable) {
      state.selectedDate = firstAvailable.date;
    }

    renderCalendar();
    renderTimes();
  } catch (error) {
    state.slots = [];
    els.bookingMode.textContent =
      "Rezervační API není dostupné. Lokálně spusťte python server.py, na webu zkontrolujte API adresu v site-config.js.";
    els.bookingMode.classList.add("is-error");
    renderCalendar();
    renderTimes();
  } finally {
    state.loading = false;
  }
}

function renderCalendarSkeleton() {
  els.monthLabel.textContent = capitalize(monthFormatter.format(state.currentMonth));
  els.calendarGrid.innerHTML = "";

  for (let index = 0; index < 42; index += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day is-empty is-loading";
    button.disabled = true;
    button.innerHTML = `<span class="day-number">&nbsp;</span><span class="day-status"></span>`;
    els.calendarGrid.append(button);
  }
}

function renderCalendar() {
  els.monthLabel.textContent = capitalize(monthFormatter.format(state.currentMonth));
  els.calendarGrid.innerHTML = "";

  const gridStart = startOfCalendarGrid(state.currentMonth);
  const todayKey = formatDateKey(new Date());
  const slotsByDate = groupSlotsByDate(state.slots);

  for (let index = 0; index < 42; index += 1) {
    const date = addDays(gridStart, index);
    const dateKey = formatDateKey(date);
    const daySlots = slotsByDate.get(dateKey) || [];
    const availableCount = daySlots.filter((slot) => slot.status === "available").length;
    const bookedCount = daySlots.filter((slot) => slot.status === "booked").length;
    const outside = date.getMonth() !== state.currentMonth.getMonth();
    const isSelected = state.selectedDate === dateKey;
    const isEmpty = availableCount === 0 && bookedCount === 0;
    const isAvailable = availableCount > 0;
    const isBookedOnly = availableCount === 0 && bookedCount > 0;

    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "calendar-day",
      outside ? "is-outside" : "",
      dateKey === todayKey ? "is-today" : "",
      isSelected ? "is-selected" : "",
      isEmpty ? "is-empty" : "",
      isAvailable ? "has-available" : "",
      isBookedOnly ? "is-booked-day" : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.dataset.date = dateKey;
    button.disabled = !isAvailable;
    button.title = isAvailable
      ? `${availableCount} volných termínů`
      : isBookedOnly
        ? "Obsazeno"
        : "Bez termínů";
    button.innerHTML = `
      <span class="day-number">${date.getDate()}</span>
      <span class="day-status">${isAvailable ? "volno" : isBookedOnly ? "obs." : ""}</span>
    `;

    button.addEventListener("click", () => {
      if (!isAvailable) return;
      state.selectedDate = dateKey;
      state.selectedSlot = null;
      renderCalendar();
      renderTimes();
      updateFormState();
    });

    els.calendarGrid.append(button);
  }
}

function renderTimes() {
  els.timeList.innerHTML = "";
  updateFormState();

  if (!state.selectedDate) {
    els.selectedDay.textContent = "Vyberte den v kalendáři";
    els.timeList.innerHTML = `<p class="booking-note">Dny s volnými termíny jsou označené zeleně.</p>`;
    return;
  }

  const daySlots = state.slots
    .filter((slot) => slot.date === state.selectedDate)
    .sort((a, b) => a.start.localeCompare(b.start));

  els.selectedDay.textContent = capitalize(dayFormatter.format(parseDateKey(state.selectedDate)));

  if (!daySlots.length) {
    els.timeList.innerHTML = `<p class="booking-note">Pro tento den nejsou dostupné žádné termíny.</p>`;
    return;
  }

  daySlots.forEach((slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "time-slot",
      slot.status === "booked" ? "is-booked" : "",
      state.selectedSlot && state.selectedSlot.id === slot.id ? "is-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.disabled = slot.status !== "available";
    button.innerHTML = `
      <strong>${slot.time}</strong>
      <span>${slot.status === "available" ? `${slot.durationMinutes} min` : "obsazeno"}</span>
    `;

    button.addEventListener("click", () => {
      if (slot.status !== "available") return;
      state.selectedSlot = slot;
      renderTimes();
      updateFormState();
    });

    els.timeList.append(button);
  });
}

function updateFormState() {
  if (!state.selectedSlot) {
    els.selectedSlot.textContent = "Nejprve vyberte čas";
    els.submit.disabled = true;
    return;
  }

  els.selectedSlot.textContent = `${state.selectedSlot.dateLabel || state.selectedDate}, ${state.selectedSlot.time}`;
  els.submit.disabled = false;
}

async function submitBooking(event) {
  event.preventDefault();

  if (!state.selectedSlot) {
    setFormStatus("Vyberte prosím volný čas.", "error");
    return;
  }

  const formData = new FormData(els.form);
  const payload = {
    slotId: state.selectedSlot.id,
    start: state.selectedSlot.start,
    end: state.selectedSlot.end,
    name: String(formData.get("name") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
    email: String(formData.get("email") || "").trim(),
    service: String(formData.get("service") || "").trim(),
    message: String(formData.get("message") || "").trim(),
    website: String(formData.get("website") || "").trim(),
  };

  setFormStatus("Odesílám rezervaci...", "");
  els.submit.disabled = true;

  try {
    const response = await fetch(apiUrl("/api/bookings"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Rezervaci se nepodařilo uložit.");
    }

    const emailMessage = data.emailSent
      ? " Potvrzení bylo odesláno na zadaný e-mail."
      : data.emailConfigured
        ? " Rezervace je uložená, ale potvrzovací e-mail se nepodařilo odeslat. Pro jistotu si termín poznamenejte."
        : " Rezervace je uložená, ale e-mailové potvrzení zatím není nastavené.";
    setFormStatus(`Rezervace je potvrzená.${emailMessage}`, "success");
    els.form.reset();
    state.selectedSlot = null;
    await loadSlots();
  } catch (error) {
    setFormStatus(error.message || "Termín už mohl být mezitím obsazený. Zkuste vybrat jiný čas.", "error");
    await loadSlots();
  } finally {
    updateFormState();
  }
}

function setFormStatus(message, type) {
  els.formStatus.textContent = message;
  els.formStatus.classList.toggle("is-error", type === "error");
  els.formStatus.classList.toggle("is-success", type === "success");
}

function groupSlotsByDate(slots) {
  const map = new Map();
  slots.forEach((slot) => {
    if (!map.has(slot.date)) map.set(slot.date, []);
    map.get(slot.date).push(slot);
  });
  return map;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function startOfCalendarGrid(monthDate) {
  const first = startOfMonth(monthDate);
  const mondayBasedIndex = (first.getDay() + 6) % 7;
  return addDays(first, -mondayBasedIndex);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
