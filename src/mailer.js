'use strict';

const nodemailer = require('nodemailer');

/**
 * Returns sendMail({ to, subject, text, replyTo }). Without SMTP settings the message is
 * printed to the server log instead, which is fine for local development.
 */
function createMailer({ host, port, user, pass, from, secure } = {}) {
  if (!host) {
    return async ({ to, subject, text, replyTo }) => {
      console.log(`[mail not configured] To: ${to}${replyTo ? `\nReply-To: ${replyTo}` : ''}\nSubject: ${subject}\n\n${text}\n`);
    };
  }
  const transport = nodemailer.createTransport({
    host,
    port: Number(port) || 465,
    secure: secure ?? (Number(port) || 465) === 465,
    auth: user ? { user, pass } : undefined,
  });
  return ({ to, subject, text, replyTo }) => transport.sendMail({ from: from || user, to, subject, text, replyTo });
}

module.exports = { createMailer };
