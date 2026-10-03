// Client-side validation for the demo contact form.
//
// Validation runs on submit and reports the first problem through a
// role=alert region. Errors are rendered from textContent, never innerHTML,
// so a message can never inject markup.

const form = document.querySelector("#contact-form");
const errorRegion = document.querySelector("#form-error");
const successRegion = document.querySelector("#form-success");

/** @returns {string | null} the first validation problem, or null if valid */
function validate(email, message) {
  const trimmedEmail = email.trim();
  if (trimmedEmail === "") {
    return "Email is required";
  }
  // Deliberately loose: enough to reject obvious junk without re-implementing
  // the HTML email grammar.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return "Enter a valid email address";
  }
  if (message.trim() === "") {
    return "Message is required";
  }
  return null;
}

function show(region, text) {
  region.textContent = text;
  region.hidden = false;
}

function hide(...regions) {
  for (const region of regions) {
    region.textContent = "";
    region.hidden = true;
  }
}

form.addEventListener("submit", (event) => {
  // No navigation: this is a static fixture with no backend.
  event.preventDefault();

  const data = new FormData(form);
  const problem = validate(String(data.get("email") ?? ""), String(data.get("message") ?? ""));

  if (problem !== null) {
    hide(successRegion);
    show(errorRegion, problem);
    return;
  }

  hide(errorRegion);
  show(successRegion, "Message sent");
  form.reset();
});
