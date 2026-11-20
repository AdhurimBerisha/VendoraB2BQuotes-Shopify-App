import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { QuotePdfData } from "../models/pdf.server";

const styles = StyleSheet.create({
  page: { padding: 36, paddingBottom: 48, fontSize: 9, fontFamily: "Noto Sans", color: "#1a1a1a" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  h1: { fontSize: 16, fontWeight: "bold" },
  muted: { color: "#616161" },
  parties: { flexDirection: "row", gap: 24, marginBottom: 16 },
  party: { flex: 1 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e3e3e3", paddingVertical: 4 },
  th: { fontWeight: "bold" },
  cSku: { width: "16%", paddingRight: 4 },
  cTitle: { width: "38%", paddingRight: 4 },
  cQty: { width: "8%", textAlign: "right" },
  cUnit: { width: "14%", textAlign: "right" },
  cDisc: { width: "10%", textAlign: "right" },
  cTotal: { width: "14%", textAlign: "right" },
  totals: { marginTop: 12, marginLeft: "55%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  block: { marginTop: 14 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 36,
    right: 36,
    fontSize: 8,
    color: "#616161",
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

const Address = ({ address }: { address: QuotePdfData["shipTo"] }) =>
  address ? (
    <Text>
      {[
        address.recipient,
        address.companyName,
        address.address1,
        address.address2,
        [address.zip, address.city].filter(Boolean).join(" "),
        address.countryCode,
      ]
        .filter(Boolean)
        .join("\n")}
    </Text>
  ) : null;

// A4, multi-page: the table header and the footer repeat on every page (`fixed`).
const QuoteDocument = ({ q }: { q: QuotePdfData }) => {
  const { t } = q;
  return (
    <Document title={`${q.numberLabel} v${q.version}`} author={q.shopName} language={q.locale}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            {q.logoUrl ? (
              <Image src={q.logoUrl} style={{ width: 110, marginBottom: 6 }} />
            ) : (
              <Text style={styles.h1}>{q.shopName}</Text>
            )}
          </View>
          <View>
            <Text style={styles.h1}>{t("pdf.title", { number: q.numberLabel })}</Text>
            <Text style={styles.muted}>
              {t("pdf.version", { version: q.version })} · {t("pdf.issued", { date: q.issuedAt })}
            </Text>
            {q.expiresAt && <Text style={styles.muted}>{t("pdf.validUntil", { date: q.expiresAt })}</Text>}
            {q.poNumber && <Text style={styles.muted}>{t("pdf.poNumber", { po: q.poNumber })}</Text>}
          </View>
        </View>

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.th}>{t("pdf.preparedFor")}</Text>
            <Text>{[q.companyName, q.locationName].filter(Boolean).join(" – ")}</Text>
            <Text>{q.contactName}</Text>
          </View>
          <View style={styles.party}>
            <Text style={styles.th}>{t("pdf.shipTo")}</Text>
            <Address address={q.shipTo} />
          </View>
          <View style={styles.party}>
            <Text style={styles.th}>{t("pdf.billTo")}</Text>
            <Address address={q.billTo} />
          </View>
        </View>

        <View style={[styles.row, styles.th]} fixed>
          <Text style={styles.cSku}>{t("pdf.sku")}</Text>
          <Text style={styles.cTitle}>{t("pdf.product")}</Text>
          <Text style={styles.cQty}>{t("pdf.qty")}</Text>
          <Text style={styles.cUnit}>{t("pdf.unitPrice")}</Text>
          <Text style={styles.cDisc}>{t("pdf.discount")}</Text>
          <Text style={styles.cTotal}>{t("pdf.lineTotal")}</Text>
        </View>
        {q.lines.map((line) => (
          <View key={line.position} style={styles.row} wrap={false}>
            <Text style={styles.cSku}>{line.sku}</Text>
            <Text style={styles.cTitle}>{line.title}</Text>
            <Text style={styles.cQty}>{line.quantity}</Text>
            <Text style={styles.cUnit}>{line.unitPrice}</Text>
            <Text style={styles.cDisc}>{line.discount}</Text>
            <Text style={styles.cTotal}>{line.lineTotal}</Text>
          </View>
        ))}

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}>
            <Text>{t("pdf.listTotal")}</Text>
            <Text>{q.listTotal}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text>{t("pdf.discounts")}</Text>
            <Text>−{q.discountTotal}</Text>
          </View>
          <View style={[styles.totalRow, styles.th]}>
            <Text>{t("pdf.totalExclTax")}</Text>
            <Text>{q.total}</Text>
          </View>
          <Text style={styles.muted}>{t("pdf.taxNote")}</Text>
        </View>

        {q.note && (
          <View style={styles.block}>
            <Text style={styles.th}>{t("pdf.notes")}</Text>
            <Text>{q.note}</Text>
          </View>
        )}
        {q.terms && (
          <View style={styles.block}>
            <Text style={styles.th}>{t("pdf.terms")}</Text>
            <Text>{q.terms}</Text>
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>{q.footer ?? q.shopName}</Text>
          <Text render={({ pageNumber, totalPages }) => t("pdf.page", { page: pageNumber, pages: totalPages })} />
        </View>
      </Page>
    </Document>
  );
};

export { QuoteDocument };
