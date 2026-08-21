# -*- coding: utf-8 -*-
"""
vnstock_compat.py -- va loi cua thu vien vnstock, khong sua duoc tu phia ta.

LOI: vnstock/core/utils/env.py :: get_hosting_service() thieu nhanh else --

    try:
        if   "google.colab" in sys.modules:            hosting_service = ...
        elif "CODESPACE_NAME" in os.environ:           hosting_service = ...
        ...
        elif ".hf.space" in os.environ["SPACE_HOST"]:  hosting_service = ...
    except Exception:
        hosting_service = "Local or Unknown"
    return hosting_service          # <-- chua duoc gan neu khong nhanh nao trung

Khi SPACE_HOST TON TAI nhung khong chua ".hf.space" (dung tren GitHub Actions)
thi elif cuoi tra False MA KHONG nem loi -> khong nhanh nao gan bien -> ham nem
UnboundLocalError, keo chet ca lan cap nhat.

Tren may ca nhan KHONG co SPACE_HOST nen os.environ["SPACE_HOST"] nem KeyError,
roi vao except va tra "Local or Unknown" -- tinh co chay dung. Vi vay bug CHI
xuat hien tren CI, chay tay o nha khong bao gio thay.

Tai hien:  SPACE_HOST="" python -c "import vnstock.core.utils.env as e; e.get_hosting_service()"

Duong di den loi: Finance(...) -> _get_company_type() -> symbols_by_industries()
-> send_request() -> is_colab() -> get_hosting_service()

Bo bien moi truong KHONG du: neu vnai/vnstock tu dat SPACE_HOST luc import thi
no quay lai sau khi ta xoa. Nen va thang vao ham, khong phu thuoc thu tu import.
"""
import os


def patch_hosting_service():
    """Boc get_hosting_service() sao cho moi loi deu tra ve 'Local or Unknown'.

    An toan goi nhieu lan; goi SAU khi vnstock da duoc import cang chac (nhung
    goi truoc cung khong sao -- ham tu import lay module).
    """
    os.environ.pop("SPACE_HOST", None)   # truong hop bien den tu moi truong

    for ten in ("vnstock.core.utils.env", "vnstock_data.core.utils.env"):
        try:
            mod = __import__(ten, fromlist=["get_hosting_service"])
        except Exception:
            continue
        goc = getattr(mod, "get_hosting_service", None)
        if goc is None or getattr(goc, "_da_va", False):
            continue

        def an_toan(_goc=goc):
            try:
                return _goc()
            except Exception:
                return "Local or Unknown"

        an_toan._da_va = True
        # is_colab() nam cung module va tra cuu ten nay luc GOI, nen gan de o day
        # la du -- khong can va rieng client.py.
        mod.get_hosting_service = an_toan
