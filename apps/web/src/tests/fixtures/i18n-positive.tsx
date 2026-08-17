declare const t: (key: string, vars?: Record<string, unknown>) => string;
export const Fixture = ({ name }: { name: string }) => <div title={t("fixture.title", { name })}>{t("fixture.body")}</div>;
