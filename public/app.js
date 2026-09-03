(function () {
  const form = document.getElementById('customer-form');
  const submitButton = document.getElementById('submit-button');
  const statusEl = document.getElementById('form-status');

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function setFieldError(name, message) {
    const input = form.elements[name];
    const errorEl = document.getElementById(`error-${name}`);
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (errorEl) errorEl.textContent = message || '';
  }

  function clearAllFieldErrors() {
    ['firstName', 'lastName', 'email', 'phone', 'note'].forEach((name) => setFieldError(name, ''));
  }

  function setStatus(message, tone) {
    statusEl.textContent = message || '';
    if (tone) {
      statusEl.setAttribute('data-tone', tone);
    } else {
      statusEl.removeAttribute('data-tone');
    }
  }

  function setLoading(isLoading) {
    submitButton.disabled = isLoading;
    submitButton.setAttribute('data-loading', String(isLoading));
  }

  function validateClientSide(data) {
    const errors = {};

    if (!data.firstName.trim()) errors.firstName = 'First name is required.';
    if (!data.lastName.trim()) errors.lastName = 'Last name is required.';

    if (!data.email.trim()) {
      errors.email = 'Email is required.';
    } else if (!EMAIL_RE.test(data.email.trim())) {
      errors.email = 'Enter a valid email address.';
    }

    if (data.phone.trim() && !/^[+()\-.\s\d]{7,20}$/.test(data.phone.trim())) {
      errors.phone = 'Enter a valid phone number.';
    }

    if (data.note.length > 500) errors.note = 'Note must be 500 characters or fewer.';

    return errors;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAllFieldErrors();
    setStatus('', null);

    const formData = new FormData(form);
    const data = {
      firstName: String(formData.get('firstName') || ''),
      lastName: String(formData.get('lastName') || ''),
      email: String(formData.get('email') || ''),
      phone: String(formData.get('phone') || ''),
      company: String(formData.get('company') || ''),
      note: String(formData.get('note') || ''),
      address1: String(formData.get('address1') || ''),
      city: String(formData.get('city') || ''),
      province: String(formData.get('province') || ''),
      zip: String(formData.get('zip') || ''),
      country: String(formData.get('country') || ''),
      acceptsMarketing: formData.get('acceptsMarketing') === 'on',
    };

    const clientErrors = validateClientSide(data);
    if (Object.keys(clientErrors).length > 0) {
      Object.entries(clientErrors).forEach(([field, message]) => setFieldError(field, message));
      setStatus('Please fix the highlighted fields.', 'error');
      return;
    }

    setLoading(true);

    try {
      const response = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (result.fields) {
          Object.entries(result.fields).forEach(([field, message]) => setFieldError(field, message));
        }
        setStatus(result.error || 'Something went wrong. Please try again.', 'error');
        return;
      }

      setStatus(`Added ${data.firstName} ${data.lastName} to Shopify.`, 'success');
      form.reset();
    } catch (err) {
      setStatus('Network error — check your connection and try again.', 'error');
    } finally {
      setLoading(false);
    }
  });
})();
