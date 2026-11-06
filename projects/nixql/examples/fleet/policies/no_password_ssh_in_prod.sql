-- Prod hosts must not allow SSH password logins.
SELECT o.host, o.value AS PasswordAuthentication
FROM opts o JOIN opts d ON d.host = o.host AND d.path = 'networking.domain'
WHERE o.path = 'services.openssh.settings.PasswordAuthentication'
  AND d.value = '"prod"' AND o.value = 'true';
