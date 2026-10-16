// Client-side validation and delivery for the demo contact form.
//
// Validation runs on submit and reports the first problem through a
// role=alert region. Errors are rendered from textContent, never innerHTML,
// so a message can never inject markup.
//
// Delivery is the server's to confirm. This used to show "Message sent" without
// a request ever leaving the page, which made the confirmation a claim about
// nothing: a test asserting it passed against an endpoint that answers 500. It
// posts now, and a failure is reported the same way a validation problem is.

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

form.addEventListener("submit", async (event) => {
  // No navigation: the page stays put and the answer arrives over the wire.
  event.preventDefault();

  const data = new FormData(form);
  const email = String(data.get("email") ?? "");
  const message = String(data.get("message") ?? "");
  const problem = validate(email, message);

  if (problem !== null) {
    hide(successRegion);
    show(errorRegion, problem);
    return;
  }

  const delivered = await fetch("/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim(), message: message.trim() }),
  }).then(
    (response) => response.ok,
    // The request never arrived: a refused connection, an aborted navigation.
    () => false,
  );

  if (!delivered) {
    hide(successRegion);
    show(errorRegion, "The message could not be sent. Try again.");
    return;
  }

  hide(errorRegion);
  show(successRegion, "Message sent");
  form.reset();
});
