export const toSseEvent = (eventName: string, data: unknown): string => {
  const payload = JSON.stringify(data);
  return `event: ${eventName}\ndata: ${payload}\n\n`;
};
