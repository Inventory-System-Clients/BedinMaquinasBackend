import { MachinePayColetaPendente } from "../models/index.js";
import { calcularTotalRecebidoMachinePay } from "./machinePayService.js";

// Trazido da AgarraMais (só a parte da Machine Pay — o Bedin não usa CompactPay).
//
// Estoque real de uma máquina com "desconto automático": a cada valorDesconto recebido
// na Machine Pay desde a última coleta a máquina libera 1 pulso/prêmio sem gerar
// movimentação, então o totalPos registrado fica desatualizado.
//
// O fechamento (Registrar Dinheiro) zera o extrato lá; o que já tinha sido recebido
// antes dele fica preservado em MachinePayColetaPendente e a consulta ao vivo parte do
// fim desse fechamento.
export const calcularEstoqueRealPagamentos = async ({ maquina, valorDesconto, totalPosAnterior, dataUltimaColeta }) => {
  const posId = maquina.machinePayPosId?.trim() || null;

  let totalMachinePay = 0;
  if (posId) {
    const pendente = await MachinePayColetaPendente.findOne({ where: { maquinaId: maquina.id } });
    const inicio =
      pendente?.dataReferencia && new Date(pendente.dataReferencia) > new Date(dataUltimaColeta)
        ? pendente.dataReferencia
        : dataUltimaColeta;
    const totalConsulta = await calcularTotalRecebidoMachinePay({ posId, inicio, fim: new Date() });
    totalMachinePay = totalConsulta + Number(pendente?.totalAcumulado || 0);
  }

  const totalRecebido = Number(totalMachinePay.toFixed(2));
  const pulsos = Math.floor(totalRecebido / valorDesconto);

  return {
    fonte: "machinePay",
    estoqueReal: Math.max(0, totalPosAnterior - pulsos),
    totalRecebidoDesdeUltimaMovimentacao: totalRecebido,
    totalMachinePay: totalRecebido,
    totalCompactPay: 0,
    pulsos,
  };
};
